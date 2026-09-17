import { useMemo, type ReactNode } from "react";
import type { Agent } from "../lib/agents";
import { MAX_STEPS_LIMIT } from "../lib/agents";
import type { RunMode } from "../lib/agentEngine";
import { allTools } from "../lib/tools/registry";
import type { Skill } from "../lib/skills";
import { AgentPipelineGraph } from "./AgentPipelineGraph";
import { Card, Section, Tabs, Field, Input, Textarea, Select, Chip } from "./ui";

const TOOL_GROUP_LABELS: Record<string, string> = {
  skills: "Skill files",
  browser: "Browse the web",
  code: "Run code",
  web: "Web search",
  fs: "File system",
  plugin: "Plugin tools",
};

/**
 * Everything that shapes how an agent behaves: identity, mode, tools, skills
 * and delegation. Split out of AgentBuilderView so the Configure/Run tabs
 * each stay a manageable size. Renders inside the one scroll container its
 * parent owns - never adds `overflow-y-auto`/`min-h-0` of its own.
 */
export function AgentConfigurePane({
  agent,
  agents,
  skills,
  modelOptions,
  running,
  currentMode,
  onUpdate,
}: {
  agent: Agent;
  agents: Agent[];
  skills: Skill[];
  modelOptions: ReactNode;
  running: boolean;
  currentMode: RunMode | null;
  onUpdate: (patch: Partial<Agent>) => void;
}) {
  const mode = agent.mode ?? "simple";

  const selectedToolIds = useMemo(() => new Set(agent.toolIds), [agent.toolIds]);
  const selectedSkillIds = useMemo(() => new Set(agent.skillIds), [agent.skillIds]);
  const selectedSubAgentIds = useMemo(() => new Set(agent.subAgentIds), [agent.subAgentIds]);
  const selectedSwarmMemberIds = useMemo(
    () => new Set(agent.swarm?.memberIds ?? agent.subAgentIds),
    [agent.swarm?.memberIds, agent.subAgentIds]
  );
  const otherAgents = useMemo(() => agents.filter((a) => a.id !== agent.id), [agents, agent.id]);

  const tools = useMemo(() => allTools(), []);
  const grouped = useMemo(() => {
    const map = new Map<string, typeof tools>();
    for (const tool of tools) {
      const list = map.get(tool.group) ?? [];
      list.push(tool);
      map.set(tool.group, list);
    }
    return [...map];
  }, [tools]);

  return (
    <div className="flex flex-col gap-4">
      <Card className="rounded-2xl">
        <input
          value={agent.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-1 py-0.5 font-display text-xl outline-none hover:border-border focus:border-accent"
        />
        <input
          value={agent.description}
          onChange={(e) => onUpdate({ description: e.target.value })}
          placeholder="What is this agent for?"
          className="mt-1 w-full rounded-lg border border-transparent bg-transparent px-1 py-0.5 text-xs text-fg-dim outline-none hover:border-border focus:border-accent"
        />

        <Field label="Instructions" className="mt-4">
          <Textarea value={agent.systemPrompt} onChange={(e) => onUpdate({ systemPrompt: e.target.value })} rows={5} />
        </Field>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Field label="Model">
            <Select value={agent.model} onChange={(e) => onUpdate({ model: e.target.value })}>
              <option value="auto">auto (router picks)</option>
              {modelOptions}
            </Select>
          </Field>
          <Field label="Max steps">
            <Input
              type="number"
              min={1}
              max={MAX_STEPS_LIMIT}
              value={agent.maxSteps}
              onChange={(e) => onUpdate({ maxSteps: Math.min(MAX_STEPS_LIMIT, Math.max(1, Number(e.target.value) || 1)) })}
            />
          </Field>
          <Field label="Token budget">
            <Input
              type="number"
              min={1000}
              step={1000}
              value={agent.tokenBudget}
              onChange={(e) => onUpdate({ tokenBudget: Math.max(1000, Number(e.target.value) || 1000) })}
            />
          </Field>
        </div>
      </Card>

      <Section
        title="Mode"
        description={
          mode === "simple"
            ? "A flat loop: call tools until it has an answer."
            : mode === "workflow"
              ? "Query decides if this needs work; Plan writes a strategy; Execute carries it out; Report synthesizes the answer."
              : "Fans a team of agents out in parallel, then synthesizes their findings - repeating until confident or capped."
        }
        actions={
          <Tabs
            value={mode}
            onChange={(v) => onUpdate({ mode: v as Agent["mode"] })}
            options={[
              { value: "simple", label: "Simple" },
              { value: "workflow", label: "Workflow" },
              { value: "swarm", label: "Swarm" },
            ]}
          />
        }
      >
        {mode === "workflow" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Max mode changes" hint="Caps Execute<->Plan re-entry so re-planning can't loop forever.">
              <Input
                type="number"
                min={1}
                value={agent.workflow?.maxModeTransitions ?? 20}
                onChange={(e) => onUpdate({ workflow: { ...agent.workflow, maxModeTransitions: Math.max(1, Number(e.target.value) || 1) } })}
              />
            </Field>
            <AgentPipelineGraph active={running ? currentMode : null} />
          </div>
        )}
        {mode === "swarm" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Members" hint="Which sub-agents (below) this swarm fans out to each round.">
              <div className="flex flex-wrap gap-1.5">
                {otherAgents.length === 0 && (
                  <p className="text-[11px] text-fg-faint">Add another agent first, then pick it as a member.</p>
                )}
                {otherAgents.map((a) => {
                  const on = selectedSwarmMemberIds.has(a.id);
                  return (
                    <Chip
                      key={a.id}
                      on={on}
                      label={a.name}
                      onClick={() => {
                        const current = agent.swarm?.memberIds ?? agent.subAgentIds;
                        const nextIds = on ? current.filter((id) => id !== a.id) : [...current, a.id];
                        onUpdate({ subAgentIds: nextIds, swarm: { ...agent.swarm, memberIds: nextIds } });
                      }}
                    />
                  );
                })}
              </div>
            </Field>
            <Field label="Convergence">
              <Select
                value={agent.swarm?.convergence ?? "adaptive"}
                onChange={(e) => onUpdate({ swarm: { ...agent.swarm, convergence: e.target.value as "fixed-rounds" | "adaptive" } })}
              >
                <option value="adaptive">Adaptive (stop early once confident)</option>
                <option value="fixed-rounds">Fixed rounds (always run every round)</option>
              </Select>
            </Field>
            <Field label="Max rounds">
              <Input
                type="number"
                min={1}
                value={agent.swarm?.maxRounds ?? 3}
                onChange={(e) => onUpdate({ swarm: { ...agent.swarm, maxRounds: Math.max(1, Number(e.target.value) || 1) } })}
              />
            </Field>
            <Field label="Max wall-clock (seconds)">
              <Input
                type="number"
                min={30}
                value={Math.round((agent.swarm?.maxWallClockMs ?? 300_000) / 1000)}
                onChange={(e) => onUpdate({ swarm: { ...agent.swarm, maxWallClockMs: Math.max(30, Number(e.target.value) || 30) * 1000 } })}
              />
            </Field>
            <Field label="Synthesis model" hint="Model used for the forced-capable synthesis call each round. Defaults to auto.">
              <Select
                value={agent.swarm?.synthesisModel ?? "auto"}
                onChange={(e) => onUpdate({ swarm: { ...agent.swarm, synthesisModel: e.target.value } })}
              >
                <option value="auto">auto (router picks)</option>
                {modelOptions}
              </Select>
            </Field>
            <Field label="Max total tokens (swarm)" hint="Across every member and synthesis call this round. Defaults to the agent's own token budget above.">
              <Input
                type="number"
                min={1000}
                step={1000}
                value={agent.swarm?.maxTotalTokens ?? agent.tokenBudget}
                onChange={(e) => onUpdate({ swarm: { ...agent.swarm, maxTotalTokens: Math.max(1000, Number(e.target.value) || 1000) } })}
              />
            </Field>
          </div>
        )}
      </Section>

      <Section title="Tools">
        <div className="space-y-2">
          {grouped.map(([group, groupTools]) => (
            <div key={group}>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-fg-faint">
                {TOOL_GROUP_LABELS[group] ?? group}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {groupTools.map((tool) => {
                  const on = selectedToolIds.has(tool.id);
                  return (
                    <Chip
                      key={tool.id}
                      on={on}
                      label={tool.id}
                      onClick={() => onUpdate({ toolIds: on ? agent.toolIds.filter((id) => id !== tool.id) : [...agent.toolIds, tool.id] })}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {skills.length > 0 && (
        <Section title="Skills">
          <div className="flex flex-wrap gap-1.5">
            {skills.map((skill) => {
              const on = selectedSkillIds.has(skill.id);
              return (
                <Chip
                  key={skill.id}
                  on={on}
                  label={skill.name}
                  onClick={() => onUpdate({ skillIds: on ? agent.skillIds.filter((id) => id !== skill.id) : [...agent.skillIds, skill.id] })}
                />
              );
            })}
          </div>
        </Section>
      )}

      {mode !== "swarm" && agents.length > 1 && (
        <Section
          title="Can delegate to"
          description="Pick other agents this one may hand sub-tasks to. Their answers come back into the shared workspace context."
        >
          <div className="flex flex-wrap gap-1.5">
            {otherAgents.map((a) => {
              const on = selectedSubAgentIds.has(a.id);
              return (
                <Chip
                  key={a.id}
                  on={on}
                  label={a.name}
                  onClick={() => onUpdate({ subAgentIds: on ? agent.subAgentIds.filter((id) => id !== a.id) : [...agent.subAgentIds, a.id] })}
                />
              );
            })}
          </div>
        </Section>
      )}
    </div>
  );
}
