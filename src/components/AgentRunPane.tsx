import { Loader2, Play, Square } from "lucide-react";
import type { Agent } from "../lib/agents";
import type { AgentRunResult, AgentStep, RunMode } from "../lib/agentEngine";
import { Markdown } from "./Markdown";
import { AgentStepRow } from "./AgentStepRow";
import { AgentPipelineGraph } from "./AgentPipelineGraph";
import { AgentSwarmLanes, type SwarmLaneState } from "./AgentSwarmLanes";
import { Card, Button, Textarea, Disclosure } from "./ui";

/**
 * Task input, run controls, live progress and the step trace. Split out of
 * AgentBuilderView so the Configure/Run tabs each stay a manageable size.
 * Renders inside the one scroll container its parent owns - never adds
 * `overflow-y-auto`/`min-h-0` of its own.
 */
export function AgentRunPane({
  mode,
  input,
  onInputChange,
  running,
  onRun,
  onStop,
  steps,
  result,
  currentMode,
  laneList,
  synthesizing,
  swarmRound,
  answerDraft,
}: {
  mode: Agent["mode"];
  input: string;
  onInputChange: (value: string) => void;
  running: boolean;
  onRun: () => void;
  onStop: () => void;
  steps: AgentStep[];
  result: AgentRunResult | null;
  currentMode: RunMode | null;
  laneList: SwarmLaneState[];
  synthesizing: boolean;
  swarmRound: number;
  answerDraft: string;
}) {
  return (
    <Card className="rounded-2xl">
      <div className="text-sm font-medium">Run</div>
      <Textarea value={input} onChange={(e) => onInputChange(e.target.value)} rows={2} placeholder="What should this agent do?" className="mt-2" />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {running ? (
          <Button size="sm" icon={<Square size={12} />} onClick={onStop}>Stop</Button>
        ) : (
          <Button size="sm" variant="primary" icon={<Play size={12} />} onClick={onRun} disabled={!input.trim()}>Run agent</Button>
        )}
        {running && (
          <span className="flex items-center gap-1.5 text-xs text-fg-faint">
            <Loader2 size={12} className="animate-spin" /> step {steps.length + 1}
          </span>
        )}
        {result && (
          <span className="text-xs text-fg-faint">
            {result.steps.length} steps · ~{result.approxTokens} tokens · {result.stoppedBecause}
          </span>
        )}
      </div>

      {mode === "workflow" && (running || currentMode) && (
        <div className="mt-3">
          <AgentPipelineGraph active={currentMode} />
        </div>
      )}
      {mode === "swarm" && laneList.length > 0 && (
        <div className="mt-3">
          <AgentSwarmLanes lanes={laneList} synthesizing={synthesizing} round={swarmRound} />
        </div>
      )}

      {answerDraft && (
        <div className="mt-3 rounded-xl border border-border-subtle bg-canvas p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-fg-faint">
            {running ? <Loader2 size={10} className="animate-spin" /> : null}
            {running ? "Answer (drafting)" : "Final answer"}
          </div>
          <div className="text-sm">
            <Markdown text={answerDraft} />
          </div>
        </div>
      )}

      {steps.length > 0 && (
        <Disclosure className="mt-3" summary={`Step trace (${steps.length})`} defaultOpen={!answerDraft}>
          <ol>
            {steps.map((step) => (
              <AgentStepRow key={`${step.depth}-${step.index}`} step={step} />
            ))}
          </ol>
        </Disclosure>
      )}
    </Card>
  );
}
