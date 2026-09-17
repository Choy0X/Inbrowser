import { useCallback, useMemo, useRef, useState } from "react";
import { Bot, Copy, Download, Plus, Trash2, Upload } from "lucide-react";
import type { Agent } from "../lib/agents";
import { agentSlug, newAgent, parseAgents, serializeAgents } from "../lib/agents";
import { runAgentStream, type AgentRunResult, type AgentStep, type EngineEvent, type RunMode } from "../lib/agentEngine";
import type { Skill } from "../lib/skills";
import type { OmniModel } from "../lib/types";
import { PageShell } from "./PageShell";
import { ConfirmDialog } from "./Dialog";
import { AgentConfigurePane } from "./AgentConfigurePane";
import { AgentRunPane } from "./AgentRunPane";
import { type SwarmLaneState } from "./AgentSwarmLanes";
import { DataConnectorsSection } from "./DataConnectorsSection";
import { Button, IconButton, Card, Badge, Tabs, EmptyState, type BadgeTone } from "./ui";
import { APP_SLUG } from "../lib/appConfig";

/**
 * Agents Builder: design an agent's mode, toolset and workspace, then watch
 * it work.
 *
 * A "simple" agent is today's flat tool-calling loop. A "workflow" agent
 * moves through Query -> Plan -> Execute -> Report, shown live as the
 * pipeline graph highlights each phase. A "swarm" agent fans its members out
 * in parallel and converges on a synthesized answer, shown as lanes
 * converging into a Synthesis node. Whatever the mode, the run trace stays
 * visible step by step - an autonomous loop that only shows a final answer
 * is impossible to trust or debug.
 *
 * The page has two independent tab levels: page-level (Agents / Connectors,
 * in PageShell's toolbar - Data Connectors is a workspace-wide resource, not
 * agent-scoped, so it gets its own tab instead of hiding above the agent
 * list) and, once an agent is selected, pane-level (Configure / Run, so a
 * long, data-dense agent doesn't force one endless scroll).
 */

const MODE_BADGE_TONE: Record<NonNullable<Agent["mode"]>, BadgeTone> = {
  simple: "neutral",
  workflow: "accent",
  swarm: "info",
};

export function AgentBuilderView({
  agents,
  onSaveAgents,
  skills,
  models,
}: {
  agents: Agent[];
  onSaveAgents: (agents: Agent[]) => void;
  skills: Skill[];
  models: OmniModel[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(agents[0]?.id ?? null);
  const [input, setInput] = useState("");
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [result, setResult] = useState<AgentRunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [answerDraft, setAnswerDraft] = useState("");
  const [currentMode, setCurrentMode] = useState<RunMode | null>(null);
  const [swarmLanes, setSwarmLanes] = useState<Map<string, SwarmLaneState>>(new Map());
  const [swarmRound, setSwarmRound] = useState(0);
  const [synthesizing, setSynthesizing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Agent | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [pageTab, setPageTab] = useState<"agents" | "connectors">("agents");
  const [paneTab, setPaneTab] = useState<"configure" | "run">("configure");
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const selected = agents.find((a) => a.id === selectedId) ?? null;
  const mode = selected?.mode ?? "simple";

  const modelOptions = useMemo(
    () => models.filter((m) => m.id !== "auto").map((m) => <option key={m.id} value={m.id}>{m.id}</option>),
    [models]
  );

  const update = useCallback(
    (patch: Partial<Agent>) => {
      if (!selected) return;
      onSaveAgents(agents.map((a) => (a.id === selected.id ? { ...a, ...patch, updatedAt: Date.now() } : a)));
    },
    [agents, onSaveAgents, selected]
  );

  const create = () => {
    const agent = newAgent();
    onSaveAgents([agent, ...agents]);
    setSelectedId(agent.id);
  };
  const duplicate = (agent: Agent) => {
    const clone = newAgent({ ...agent, name: `${agent.name} (copy)` });
    onSaveAgents([clone, ...agents]);
    setSelectedId(clone.id);
  };
  const remove = (agent: Agent) => {
    onSaveAgents(agents.filter((a) => a.id !== agent.id));
    if (selectedId === agent.id) setSelectedId(null);
    setConfirmDelete(null);
  };
  const exportAgents = () => {
    const blob = new Blob([serializeAgents(agents)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${APP_SLUG}-agents.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const importAgents = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    void (async () => {
      try {
        const imported = parseAgents(await file.text());
        onSaveAgents([...imported, ...agents]);
        setImportError(null);
      } catch (err) {
        setImportError(err instanceof Error ? err.message : "Could not read that file.");
      }
    })();
  };

  const applyEvent = useCallback((ev: EngineEvent) => {
    if (ev.kind === "step") {
      setSteps((s) => [...s, ev.step]);
      return;
    }
    if (ev.kind === "mode-change") {
      setCurrentMode(ev.transition.to);
      return;
    }
    if (ev.kind === "answer-draft" || ev.kind === "answer-final") {
      setAnswerDraft(ev.text);
      return;
    }
    if (ev.kind === "swarm-lane") {
      setSwarmLanes((prev) => {
        const next = new Map(prev);
        const existing = next.get(ev.memberId) ?? { memberId: ev.memberId, memberName: ev.memberName, steps: [] as AgentStep[], status: "running" as const };
        if (ev.event.kind === "step") {
          next.set(ev.memberId, { ...existing, steps: [...existing.steps, ev.event.step], status: "running" });
        } else if (ev.event.kind === "done") {
          const failed = ev.event.result.stoppedBecause === "error";
          next.set(ev.memberId, { ...existing, status: failed ? "error" : "done" });
        }
        return next;
      });
      return;
    }
    if (ev.kind === "done") {
      setResult(ev.result);
      // A swarm-lane "step" only ever comes from a member; the *outer* swarm
      // agent's own "Round N: fanning out..." step arrives as a plain "step"
      // event (handled above), so detect round/synthesis transitions there.
    }
  }, []);

  // Separately watch the plain step stream (not swarm-lane-wrapped) for the
  // swarm loop's own round/synthesis markers - it owns this exact text (see
  // swarmLoop.ts), so parsing it here is a controlled, same-codebase seam,
  // not scraping an unrelated format.
  const applyTopLevelStep = useCallback((step: AgentStep) => {
    if (step.depth !== 0 || step.kind !== "thinking" || !step.text) return;
    const roundMatch = /^Round (\d+): fanning out/.exec(step.text);
    if (roundMatch) {
      setSwarmRound(Number(roundMatch[1]));
      setSwarmLanes(new Map());
      setSynthesizing(false);
      return;
    }
    if (step.text.startsWith("Synthesis (round")) {
      setSynthesizing(false);
      return;
    }
  }, []);

  const run = () => {
    if (!selected || !input.trim()) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setSteps([]);
    setResult(null);
    setAnswerDraft("");
    setCurrentMode(null);
    setSwarmLanes(new Map());
    setSwarmRound(0);
    setSynthesizing(false);

    void (async () => {
      try {
        for await (const ev of runAgentStream({
          agent: selected,
          input: input.trim(),
          agents,
          skills,
          signal: controller.signal,
        })) {
          applyEvent(ev);
          if (ev.kind === "step") applyTopLevelStep(ev.step);
          // All swarm members have settled once every current lane is done/error - the
          // next thing the loop does is call synthesis, so light that node up now.
          if (ev.kind === "swarm-lane" && ev.event.kind === "done") {
            setSwarmLanes((prev) => {
              const all = [...prev.values()];
              if (all.length > 0 && all.every((l) => l.status !== "running")) setSynthesizing(true);
              return prev;
            });
          }
        }
      } finally {
        setRunning(false);
        abortRef.current = null;
      }
    })();
  };

  const laneList = useMemo(() => [...swarmLanes.values()], [swarmLanes]);

  return (
    <PageShell
      title="Agents"
      icon={<Bot size={24} className="shrink-0 text-accent" />}
      maxWidth="max-w-6xl"
      bodyScrolls={false}
      subtitle="Agents work through a goal on their own, using the tools and workspace you give them."
      actions={
        pageTab === "agents" ? (
          <>
            <Button size="sm" icon={<Upload size={13} />} onClick={() => fileRef.current?.click()}>Import</Button>
            <Button size="sm" icon={<Download size={13} />} onClick={exportAgents}>Export</Button>
            <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={create}>New agent</Button>
            <input ref={fileRef} type="file" accept=".json" onChange={importAgents} className="hidden" />
          </>
        ) : undefined
      }
      toolbar={
        <Tabs
          value={pageTab}
          onChange={setPageTab}
          options={[
            { value: "agents", label: "Agents" },
            { value: "connectors", label: "Connectors" },
          ]}
        />
      }
    >
      {importError && <p className="mb-2 text-xs text-error">{importError}</p>}

      {pageTab === "connectors" ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <DataConnectorsSection />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <aside className="flex gap-2 overflow-x-auto pb-1 lg:min-h-0 lg:flex-col lg:gap-1.5 lg:overflow-y-auto lg:overflow-x-visible lg:pb-0">
            {agents.map((agent) => (
              <Card
                key={agent.id}
                as="button"
                onClick={() => setSelectedId(agent.id)}
                selected={selectedId === agent.id}
                padded={false}
                className="flex w-44 shrink-0 flex-col gap-1 rounded-lg p-3 text-left transition-colors hover:bg-bg-hover lg:w-full lg:shrink"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium">{agent.name}</span>
                  <Badge tone={MODE_BADGE_TONE[agent.mode ?? "simple"]}>{agent.mode ?? "simple"}</Badge>
                </div>
                <span className="truncate text-[11px] text-fg-faint">
                  /{agentSlug(agent)} · {agent.toolIds.length} tool{agent.toolIds.length === 1 ? "" : "s"}
                </span>
              </Card>
            ))}
            {agents.length === 0 && (
              <EmptyState title="No agents yet" description="Create one to get started." className="lg:w-full" />
            )}
          </aside>

          {!selected ? (
            <EmptyState icon={<Bot size={28} />} title="Select an agent, or create one." />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate font-display text-lg">{selected.name}</span>
                  <Badge tone={MODE_BADGE_TONE[selected.mode ?? "simple"]}>{selected.mode ?? "simple"}</Badge>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <IconButton label="Duplicate" icon={<Copy size={14} />} size="sm" onClick={() => duplicate(selected)} />
                  <IconButton label="Delete" icon={<Trash2 size={14} />} size="sm" className="hover:text-error" onClick={() => setConfirmDelete(selected)} />
                  <Tabs
                    value={paneTab}
                    onChange={setPaneTab}
                    options={[
                      { value: "configure", label: "Configure" },
                      { value: "run", label: "Run" },
                    ]}
                  />
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                {paneTab === "configure" ? (
                  <AgentConfigurePane
                    agent={selected}
                    agents={agents}
                    skills={skills}
                    modelOptions={modelOptions}
                    running={running}
                    currentMode={currentMode}
                    onUpdate={update}
                  />
                ) : (
                  <AgentRunPane
                    mode={mode}
                    input={input}
                    onInputChange={setInput}
                    running={running}
                    onRun={run}
                    onStop={() => abortRef.current?.abort()}
                    steps={steps}
                    result={result}
                    currentMode={currentMode}
                    laneList={laneList}
                    synthesizing={synthesizing}
                    swarmRound={swarmRound}
                    answerDraft={answerDraft}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete agent?"
        message={`"${confirmDelete?.name}" will be removed. This can't be undone.`}
        confirmLabel="Delete"
        onConfirm={() => confirmDelete && remove(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
      />
    </PageShell>
  );
}
