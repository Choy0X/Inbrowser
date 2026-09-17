import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import { onLocalProgress, type LocalModelProgress as Progress } from "../lib/gateway/local/progress";
import { Tooltip } from "./Tooltip";

/**
 * Load progress for a local model.
 *
 * The first message to a local model downloads and compiles its weights, which
 * can take minutes and several GB. The adapter interface only carries tokens,
 * so progress arrives on its own channel (gateway/local/progress.ts) and this
 * subscribes directly rather than threading a prop through ChatView. Without
 * it, the app would simply appear frozen on first use.
 */
export function LocalModelProgress() {
  const [progress, setProgress] = useState<Progress | null>(null);

  useEffect(() => onLocalProgress(setProgress), []);

  // Nothing to show once the model is resident and generating - the usual
  // streaming indicator takes over from there.
  if (!progress || progress.done) return null;

  const pct = typeof progress.progress === "number" ? Math.round(progress.progress * 100) : null;
  const name = progress.modelId.split("/").pop()?.replace(/-MLC$/, "") ?? progress.modelId;

  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-40 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2">
      <div className="pointer-events-auto rounded-xl border border-border bg-bg-elevated p-3 shadow-lift">
        <div className="flex items-center gap-2">
          <Cpu size={14} className="shrink-0 text-accent" />
          <span className="truncate text-xs font-medium">Preparing {name}</span>
          {pct !== null && <span className="ml-auto shrink-0 text-xs tabular-nums text-fg-dim">{pct}%</span>}
        </div>

        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-canvas">
          <div
            className={`h-full rounded-full bg-accent transition-[width] ${pct === null ? "animate-pulse" : ""}`}
            style={{ width: pct === null ? "35%" : `${pct}%` }}
          />
        </div>

        <Tooltip label={progress.text}>
          <p className="mt-1.5 truncate text-[11px] leading-4 text-fg-faint">{progress.text}</p>
        </Tooltip>
        <p className="mt-0.5 text-[11px] leading-4 text-fg-faint">
          Downloaded once, then it runs offline on this device.
        </p>
      </div>
    </div>
  );
}
