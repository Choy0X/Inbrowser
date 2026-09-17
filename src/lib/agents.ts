import { newId } from "./store";

/**
 * Agents.
 *
 * A skill is instructions plus files, injected into a normal chat. An agent is
 * the thing that *acts*: it owns a toolset, a model policy, and a bounded
 * plan-act-observe loop that keeps going until the task is done rather than
 * replying once. Agents can also call other agents, which is how a
 * researcher -> writer -> critic pipeline is expressed without new machinery.
 *
 * Everything is stored client-side, like the rest of the app.
 */

export interface Agent {
  id: string;
  name: string;
  description: string;
  /** The agent's own operating instructions, injected as its system prompt. */
  systemPrompt: string;
  /** "auto" or a fully-qualified "alias/modelId". */
  model: string;
  /** Tool ids from lib/tools/registry.ts. */
  toolIds: string[];
  /** Skills injected for the run, so an agent can reuse packaged expertise. */
  skillIds: string[];
  /** Hard cap on plan-act-observe iterations. */
  maxSteps: number;
  /** Rough cap on generated tokens across the whole run. */
  tokenBudget: number;
  /** Agents this one may delegate to via the call_agent tool. */
  subAgentIds: string[];
  /**
   * "simple" (default): today's flat tool-calling loop. "workflow": the
   * Query/Plan/Execute/Report state machine. "swarm": parallel multi-agent
   * research with a synthesis step. Absent on any agent saved before this
   * field existed - loadAgents() normalizes those to "simple" so they keep
   * running exactly as they always have.
   */
  mode?: "simple" | "workflow" | "swarm";
  /** Config for mode "workflow" (the Query/Plan/Execute/Report loop). Ignored otherwise. */
  workflow?: {
    /** Draft the answer on a cheap model while Execute keeps working, superseded by Report's final call. Off by default. */
    streamAnswerDuringExecution?: boolean;
    /** Hard cap on Execute<->Plan re-entries, so re-planning can't loop forever. */
    maxModeTransitions?: number;
    /** Hard cap on draft rounds when streamAnswerDuringExecution is on. */
    maxDraftRounds?: number;
  };
  /** Config for mode "swarm" (parallel multi-agent research + synthesis). Ignored otherwise. */
  swarm?: {
    /** Sub-agent ids to fan out to. Falls back to subAgentIds if unset. */
    memberIds?: string[];
    /** Hard cap on research/synthesis rounds. */
    maxRounds?: number;
    /** Hard cap on total wall-clock time for the whole swarm run. */
    maxWallClockMs?: number;
    /** Hard cap on tokens used across every member and every synthesis call this run. */
    maxTotalTokens?: number;
    /** "auto" (routed with forceCapable) or a fully-qualified "alias/modelId" for the synthesis step. */
    synthesisModel?: string;
    /** "fixed-rounds": always run maxRounds. "adaptive": also stop early on a confident, complete synthesis. */
    convergence?: "fixed-rounds" | "adaptive";
    /** Confidence threshold (0..1) the synthesis must clear to stop early, when convergence is "adaptive". */
    minConfidence?: number;
  };
  createdAt: number;
  updatedAt: number;
}

const KEY = "fachoy:agents:v1";

export const MAX_STEPS_LIMIT = 50;
/** Depth cap on agent -> sub-agent -> sub-agent, so a cycle cannot run away. */
export const MAX_AGENT_DEPTH = 3;

export function newAgent(partial: Partial<Agent> = {}): Agent {
  const now = Date.now();
  return {
    id: newId(),
    name: "New agent",
    description: "",
    systemPrompt:
      "You are an autonomous agent. Work through the user's request step by step, using your tools " +
      "to gather facts rather than guessing. When you have the answer, state it plainly and stop.",
    model: "auto",
    toolIds: [],
    skillIds: [],
    maxSteps: 12,
    tokenBudget: 40_000,
    subAgentIds: [],
    mode: "simple",
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

export const EXAMPLE_AGENTS: Agent[] = [
  {
    ...newAgent({
      id: "agent-researcher",
      name: "Web researcher",
      description: "Searches the web, reads the best sources, and reports what it actually found.",
      systemPrompt:
        "You are a research agent. Search the web, open the most promising results, and read them before " +
        "answering. Prefer primary sources. Quote exact figures and dates rather than paraphrasing them, and " +
        "cite the URL each fact came from. If the sources disagree or you cannot confirm something, say so " +
        "explicitly instead of settling on a confident-sounding guess. Stop as soon as you can answer.",
      toolIds: ["browser_search", "browser_open", "browser_follow", "browser_find", "browser_links"],
      maxSteps: 14,
    }),
  },
  {
    ...newAgent({
      id: "agent-analyst",
      name: "Data analyst",
      description: "Computes answers by running code instead of estimating them.",
      systemPrompt:
        "You are a data analyst. When a question involves arithmetic, parsing, statistics or data " +
        "transformation, write and run code to get the answer rather than working it out in your head. " +
        "Show the code you ran and the output it produced, then give the conclusion in plain language.",
      toolIds: ["run_code"],
      maxSteps: 10,
    }),
  },
  {
    ...newAgent({
      id: "agent-research-team",
      name: "Research team",
      description: "Fans the web researcher and data analyst out in parallel, then synthesizes their findings.",
      systemPrompt:
        "You coordinate a small research team. Weigh what each member actually found, note real disagreements " +
        "rather than smoothing them over, and give a single clear answer.",
      mode: "swarm",
      subAgentIds: ["agent-researcher", "agent-analyst"],
      swarm: { memberIds: ["agent-researcher", "agent-analyst"], maxRounds: 2, convergence: "adaptive" },
    }),
  },
];

/** An agent saved before `mode` existed loads and runs exactly as it always has. */
function normalizeAgent(a: Agent): Agent {
  return { mode: "simple", ...a };
}

export function loadAgents(): Agent[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const normalized = parsed.map(normalizeAgent);
        const ids = new Set(normalized.map((a: Agent) => a.id));
        return [...normalized, ...EXAMPLE_AGENTS.filter((a) => !ids.has(a.id))];
      }
    }
  } catch {
    /* ignore */
  }
  return EXAMPLE_AGENTS.map((a) => ({ ...a }));
}

export function saveAgents(agents: Agent[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(agents));
  } catch {
    /* ignore */
  }
}

export function agentSlug(agent: Agent): string {
  return (
    agent.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || agent.id
  );
}

/** Export/import so agents are shareable the way skills already are. */
export function serializeAgents(agents: Agent[]): string {
  return JSON.stringify({ version: 1, agents }, null, 2);
}

export function parseAgents(json: string): Agent[] {
  const parsed = JSON.parse(json) as { agents?: Agent[] } | Agent[];
  const list = Array.isArray(parsed) ? parsed : parsed.agents;
  if (!Array.isArray(list)) throw new Error("That file doesn't contain any agents.");
  return list.map((a) => ({ ...newAgent(), ...a, id: newId() }));
}
