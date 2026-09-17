import type { RunMode } from "../lib/agentEngine";

/**
 * The Query -> Plan -> Execute -> Report state machine, drawn as a small
 * inline-SVG pipeline. No graph library - four boxes and a few paths is not
 * worth a new dependency. `active` highlights the current node during a
 * live run (driven by the engine's "mode-change" events); idle otherwise.
 */
const NODES: { mode: RunMode; label: string; x: number }[] = [
  { mode: "query", label: "Query", x: 8 },
  { mode: "plan", label: "Plan", x: 108 },
  { mode: "execute", label: "Execute", x: 208 },
  { mode: "report", label: "Report", x: 308 },
];
const NODE_W = 84;
const NODE_H = 36;
const Y = 30;

export function AgentPipelineGraph({ active }: { active?: RunMode | null }) {
  return (
    <svg viewBox="0 0 400 90" className="w-full" role="img" aria-label="Query, Plan, Execute, Report pipeline">
      <defs>
        <marker id="pg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L8,4 L0,8 Z" fill="rgb(var(--fg-faint))" />
        </marker>
      </defs>

      {/* Forward edges: query->plan->execute->report */}
      {NODES.slice(0, -1).map((n, i) => (
        <line
          key={n.mode}
          x1={n.x + NODE_W}
          y1={Y + NODE_H / 2}
          x2={NODES[i + 1].x}
          y2={Y + NODE_H / 2}
          stroke="rgb(var(--fg-faint))"
          strokeWidth={1.5}
          markerEnd="url(#pg-arrow)"
        />
      ))}

      {/* Execute -> Plan re-entry loop (re-planning), drawn as a dashed arc below. */}
      <path
        d={`M ${NODES[2].x + NODE_W / 2} ${Y + NODE_H} C ${NODES[2].x + NODE_W / 2} ${Y + NODE_H + 24}, ${NODES[1].x + NODE_W / 2} ${Y + NODE_H + 24}, ${NODES[1].x + NODE_W / 2} ${Y + NODE_H}`}
        fill="none"
        stroke="rgb(var(--fg-faint))"
        strokeWidth={1.25}
        strokeDasharray="3 3"
        markerEnd="url(#pg-arrow)"
      />
      <text
        x={(NODES[1].x + NODES[2].x + NODE_W) / 2}
        y={Y + NODE_H + 34}
        textAnchor="middle"
        className="fill-fg-faint text-[8px] font-mono uppercase tracking-wide"
      >
        re-plan
      </text>

      {NODES.map(({ mode, label, x }) => {
        const isActive = active === mode;
        return (
          <g key={mode}>
            <rect
              x={x}
              y={Y}
              width={NODE_W}
              height={NODE_H}
              rx={8}
              fill={isActive ? "rgb(var(--accent) / 0.12)" : "rgb(var(--bg-elevated))"}
              stroke={isActive ? "rgb(var(--accent))" : "rgb(var(--border))"}
              strokeWidth={isActive ? 1.75 : 1}
              className={isActive ? "transition-all" : "transition-all"}
            />
            <text
              x={x + NODE_W / 2}
              y={Y + NODE_H / 2 + 4}
              textAnchor="middle"
              className={`font-mono text-[11px] uppercase tracking-wide ${isActive ? "fill-accent" : "fill-fg-dim"}`}
            >
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
