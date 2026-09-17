import { chatStream, type ChatMessageInput } from "../onniroute";
import { approxTokens, type RunAgentOptions, type AgentRunResult, type AgentStep } from "../agentRunner";
import type { Agent } from "../agents";
import type { EngineEvent } from "./types";
import { runAgentStream } from "./index";

/**
 * Parallel multi-agent research + iterative synthesis.
 *
 * Fan-out (true parallel, Promise.allSettled - one member failing doesn't
 * abort the round) -> barrier (wait for every member to settle) -> merge
 * (in declared member order, not settle order, so a round's synthesis
 * prompt is reproducible run to run despite real network-latency jitter) ->
 * synthesis (forced onto a capable model via chatStream's forceCapableModel)
 * -> either stop or feed the synthesis back as next round's task ("refine
 * given this so far"). Bounded like every loop in this codebase: hard caps
 * on rounds, wall-clock time and total tokens, on top of any adaptive
 * confidence-based early stop - never a truly unbounded "keep going".
 */

const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_MAX_WALL_CLOCK_MS = 300_000;
const DEFAULT_MIN_CONFIDENCE = 0.8;
/** Word-overlap ratio above which two rounds' syntheses are "the same answer again". */
const DIMINISHING_RETURNS_SIMILARITY = 0.9;

function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) if (wordsB.has(w)) intersection++;
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

function parseConfidenceMarker(text: string): { confidence?: number; complete?: boolean } {
  const matches = [...text.matchAll(/\{[^{}]*"confidence"[^{}]*\}/g)];
  const last = matches[matches.length - 1];
  if (!last) return {};
  try {
    const obj = JSON.parse(last[0]) as { confidence?: unknown; complete?: unknown };
    return {
      confidence: typeof obj.confidence === "number" ? obj.confidence : undefined,
      complete: typeof obj.complete === "boolean" ? obj.complete : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Fans N members' runAgentStream() calls into one live event stream, using
 * the same queue+wake bridge simpleLoop.ts uses to turn a push source into a
 * pulled async sequence - here with N concurrent producers instead of one.
 * Returns (via the generator's return value) every member's settled outcome,
 * Promise.allSettled-shaped, once all of them are done.
 */
async function* fanOutRound(
  members: Agent[],
  task: string,
  options: RunAgentOptions,
  depth: number,
): AsyncGenerator<EngineEvent, PromiseSettledResult<AgentRunResult>[]> {
  const queue: EngineEvent[] = [];
  let wake: (() => void) | null = null;
  const push = (ev: EngineEvent): void => {
    queue.push(ev);
    wake?.();
    wake = null;
  };

  const settled: PromiseSettledResult<AgentRunResult>[] = new Array(members.length);
  let settledCount = 0;

  members.forEach((member, i) => {
    void (async () => {
      let result: AgentRunResult | undefined;
      for await (const ev of runAgentStream({ ...options, agent: member, input: task, depth: depth + 1 })) {
        // Forwards the member's full event stream, including "step" events
        // carrying complete AgentStep payloads - the UI already has enough
        // here to show a per-member trace, not just a status summary.
        push({ kind: "swarm-lane", memberId: member.id, memberName: member.name, event: ev });
        if (ev.kind === "done") result = ev.result;
      }
      return result!;
    })()
      .then((value) => {
        settled[i] = { status: "fulfilled", value };
      })
      .catch((reason: unknown) => {
        settled[i] = { status: "rejected", reason };
      })
      .finally(() => {
        settledCount++;
        wake?.();
        wake = null;
      });
  });

  while (settledCount < members.length || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      continue;
    }
    yield queue.shift()!;
  }
  return settled;
}

export async function* swarmLoop(options: RunAgentOptions): AsyncGenerator<EngineEvent, AgentRunResult> {
  const { agent, input, agents, signal } = options;
  const depth = options.depth ?? 0;
  const config = agent.swarm ?? {};
  const memberIds = config.memberIds && config.memberIds.length > 0 ? config.memberIds : agent.subAgentIds;
  const members = memberIds
    .map((id) => agents.find((a) => a.id === id))
    .filter((a): a is Agent => Boolean(a));

  const steps: AgentStep[] = [];
  let stepIndex = 0;
  const emit = (step: Omit<AgentStep, "index" | "depth" | "agentName">): void => {
    const full: AgentStep = { ...step, index: stepIndex++, depth, agentName: agent.name };
    steps.push(full);
    options.onStep?.(full);
  };

  if (members.length === 0) {
    emit({
      kind: "error",
      text: "This swarm agent has no members configured (set agent.swarm.memberIds, or subAgentIds).",
      durationMs: 0,
    });
    const result: AgentRunResult = { steps, answer: "", stoppedBecause: "error", approxTokens: 0 };
    yield { kind: "done", result };
    return result;
  }

  const maxRounds = config.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxWallClockMs = config.maxWallClockMs ?? DEFAULT_MAX_WALL_CLOCK_MS;
  const maxTotalTokens = config.maxTotalTokens ?? agent.tokenBudget;
  const convergence = config.convergence ?? "adaptive";
  const minConfidence = config.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  const startedAt = performance.now();
  let round = 0;
  let totalTokens = 0;
  let task = input;
  let synthesis = "";
  let previousSynthesis = "";
  let stoppedBecause: AgentRunResult["stoppedBecause"] = "answered";

  while (true) {
    round++;
    if (signal?.aborted) {
      stoppedBecause = "aborted";
      emit({ kind: "stopped", text: "Run aborted.", durationMs: 0 });
      break;
    }
    if (round > maxRounds) {
      stoppedBecause = "max-rounds";
      break;
    }
    if (performance.now() - startedAt > maxWallClockMs) {
      stoppedBecause = "wall-clock";
      break;
    }
    if (totalTokens >= maxTotalTokens) {
      stoppedBecause = "token-budget";
      break;
    }

    emit({ kind: "thinking", text: `Round ${round}: fanning out to ${members.length} agent(s).`, durationMs: 0 });

    const fanOut = fanOutRound(members, task, options, depth);
    let settled: PromiseSettledResult<AgentRunResult>[] = [];
    while (true) {
      const next = await fanOut.next();
      if (next.done) {
        settled = next.value;
        break;
      }
      yield next.value;
    }

    // Merge in declared member order, not settle order - keeps the synthesis
    // prompt reproducible across runs despite real network-latency jitter.
    const findings: { name: string; text: string }[] = [];
    for (let i = 0; i < members.length; i++) {
      const member = members[i];
      const outcome = settled[i];
      if (outcome.status === "fulfilled") {
        findings.push({ name: member.name, text: outcome.value.answer || "(no answer)" });
        totalTokens += outcome.value.approxTokens;
      } else {
        findings.push({ name: member.name, text: `(failed: ${String(outcome.reason)})` });
      }
    }

    const synthMessages: ChatMessageInput[] = [
      { role: "system", content: agent.systemPrompt },
      {
        role: "system",
        content:
          "You are synthesizing findings from a team of research agents into the best possible answer for the " +
          "user's original request. Weigh conflicting findings, note real disagreements rather than papering " +
          'over them, and after your answer output a fenced JSON block on its own, exactly like:\n```json\n' +
          '{"confidence": 0.0-1.0, "complete": true or false}\n```\n' +
          "confidence: how confident you are in this answer. complete: whether it fully addresses the request " +
          "with no meaningful gaps left to fill.",
      },
      {
        role: "user",
        content:
          `Original request: ${input}\n\nFindings from ${members.length} agent(s):\n\n` +
          findings.map((f) => `### ${f.name}\n${f.text}`).join("\n\n"),
      },
    ];

    const synthStarted = performance.now();
    let synthText = "";
    try {
      const result = await chatStream({
        model: config.synthesisModel ?? "auto",
        forceCapableModel: true,
        messages: synthMessages,
        signal,
        onDelta: (d) => (synthText += d),
      });
      totalTokens += approxTokens(synthText);
      emit({
        kind: "thinking",
        text: `Synthesis (round ${round})`,
        model: result.resolvedModel ?? undefined,
        proxy: result.resolvedProxy,
        durationMs: performance.now() - synthStarted,
      });
    } catch (err) {
      stoppedBecause = "error";
      emit({ kind: "error", text: err instanceof Error ? err.message : "The synthesis call failed.", durationMs: performance.now() - synthStarted });
      break;
    }

    previousSynthesis = synthesis;
    synthesis = synthText;
    const { confidence, complete } = parseConfidenceMarker(synthText);

    if (convergence === "adaptive" && confidence !== undefined && confidence >= minConfidence && complete) {
      stoppedBecause = "answered";
      break;
    }
    if (round > 1 && jaccardSimilarity(previousSynthesis, synthesis) >= DIMINISHING_RETURNS_SIMILARITY) {
      stoppedBecause = "diminishing-returns";
      break;
    }
    if (convergence === "fixed-rounds" && round >= maxRounds) {
      stoppedBecause = "answered";
      break;
    }

    task = `Refine and deepen your findings given this synthesis so far, addressing any gaps or disagreements:\n\n${synthesis}`;
  }

  const answer = synthesis.replace(/```json[\s\S]*?```/g, "").trim();
  const result: AgentRunResult = { steps, answer, stoppedBecause, approxTokens: totalTokens };
  if (answer) yield { kind: "answer-final", text: answer };
  yield { kind: "done", result };
  return result;
}
