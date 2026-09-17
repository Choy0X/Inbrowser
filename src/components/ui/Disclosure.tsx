import { useEffect, useRef, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/**
 * A collapsible section with one consistent affordance (chevron + elevated
 * summary bar) instead of every screen styling raw `<details>` differently.
 * Native `<details>/<summary>` underneath, so keyboard and AT semantics are
 * free - this only adds the app's visual chrome and an optional controlled mode.
 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  open,
  onOpenChange,
  className = "",
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  /** Controlled mode: when set, this component drives the open state instead of the DOM. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (open !== undefined && ref.current) ref.current.open = open;
  }, [open]);

  return (
    <details
      ref={ref}
      data-ui="disclosure"
      className={`group overflow-hidden rounded-xl border border-border-subtle ${className}`}
      {...(open === undefined ? { defaultOpen } : {})}
      onToggle={(e) => onOpenChange?.(e.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 bg-bg-elevated px-3 py-2 text-xs font-medium text-fg-dim">
        <ChevronRight size={12} className="shrink-0 transition-transform group-open:rotate-90" />
        <span className="min-w-0 flex-1">{summary}</span>
      </summary>
      {children}
    </details>
  );
}
