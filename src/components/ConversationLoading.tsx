import { Loader2 } from "lucide-react";

interface ConversationLoadingProps {
  processed: number;
  total: number;
}

/**
 * Shown in place of the virtualized message list while a legacy
 * conversation's one-time fence-artifact migration (messageMigrations.ts) is
 * still chunking through its messages in the background. Only ever mounted
 * once App.tsx's reveal-delay timer decides the migration is genuinely slow
 * enough to be worth surfacing — a fast/small conversation never renders
 * this at all.
 */
export function ConversationLoading({ processed, total }: ConversationLoadingProps) {
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 100;
  return (
    <div className="flex min-h-full flex-1 flex-col items-center justify-center gap-3 py-12">
      <div className="flex items-center gap-2 text-sm text-fg-dim">
        <Loader2 size={16} className="animate-spin" />
        <span>Preparing conversation…</span>
      </div>
      <div className="h-1.5 w-56 overflow-hidden rounded-full bg-bg-elevated">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-150 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-fg-faint">{pct}%</span>
    </div>
  );
}
