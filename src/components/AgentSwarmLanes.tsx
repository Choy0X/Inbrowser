import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import type { AgentStep } from "../lib/agentEngine";
import { AgentStepRow } from "./AgentStepRow";
import { Disclosure } from "./ui";

export interface SwarmLaneState {
  memberId: string;
  memberName: string;
  steps: AgentStep[];
  status: "running" | "done" | "error";
}

function SwarmLaneRow({ lane }: { lane: SwarmLaneState }) {
  const summary = (
    <div className="flex items-center gap-2">
      {lane.status === "running" && <Loader2 size={12} className="shrink-0 animate-spin text-fg-faint" />}
      {lane.status === "done" && <CheckCircle2 size={12} className="shrink-0 text-success" />}
      {lane.status === "error" && <XCircle size={12} className="shrink-0 text-error" />}
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{lane.memberName}</span>
      <span className="shrink-0 text-[11px] text-fg-faint">{lane.steps.length} step{lane.steps.length === 1 ? "" : "s"}</span>
    </div>
  );

  if (lane.steps.length === 0) {
    return <div className="rounded-lg border border-border-subtle bg-bg-elevated px-2.5 py-1.5">{summary}</div>;
  }

  return (
    <Disclosure summary={summary} defaultOpen={false}>
      <ol>
        {lane.steps.map((step) => (
          <AgentStepRow key={`${lane.memberId}-${step.index}`} step={step} />
        ))}
      </ol>
    </Disclosure>
  );
}

/**
 * One lane per swarm member, converging into a Synthesis node - plain flex
 * layout with a small SVG connector overlay, not a graph library. Lanes
 * update live as swarm-lane events arrive; expanding a lane shows that
 * member's own step trace, since a status summary alone can't be trusted or
 * debugged the way a step-by-step trace can. The Synthesis node lights up
 * once a round's fan-out has fully settled and the synthesis call starts.
 */
export function AgentSwarmLanes({
  lanes,
  synthesizing,
  round,
}: {
  lanes: SwarmLaneState[];
  synthesizing: boolean;
  round: number;
}) {
  if (lanes.length === 0) return null;

  return (
    <div className="flex items-stretch gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="text-[10px] font-medium uppercase tracking-wide text-fg-faint">Round {round}</div>
        {lanes.map((lane) => (
          <SwarmLaneRow key={lane.memberId} lane={lane} />
        ))}
      </div>

      <div className="flex w-8 shrink-0 items-center justify-center text-fg-faint">
        <svg viewBox="0 0 24 24" className="h-full w-6" preserveAspectRatio="none">
          <line x1="0" y1="4" x2="24" y2="12" stroke="rgb(var(--border))" strokeWidth={1} />
          <line x1="0" y1="20" x2="24" y2="12" stroke="rgb(var(--border))" strokeWidth={1} />
        </svg>
      </div>

      <div
        className={`flex w-32 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border px-3 py-2 text-center transition-colors ${
          synthesizing ? "border-accent bg-accent/10" : "border-border-subtle bg-bg-elevated"
        }`}
      >
        {synthesizing && <Loader2 size={14} className="animate-spin text-accent" />}
        <span className={`font-mono text-[10px] uppercase tracking-wide ${synthesizing ? "text-accent" : "text-fg-dim"}`}>
          Synthesis
        </span>
      </div>
    </div>
  );
}
