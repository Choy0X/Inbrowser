import type { ReactNode } from "react";

/**
 * A multi-select toggle pill - distinct from `Tabs` (pick exactly one) and
 * `Toggle` (a single on/off switch). Used wherever a screen lets you pick any
 * number of items from a set: tools, skills, delegate targets, swarm members.
 */
export function Chip({
  on,
  label,
  onClick,
  disabled,
  className = "",
}: {
  on: boolean;
  label: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-ui="chip"
      data-active={on ? "" : undefined}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        on ? "border-accent bg-accent/10 text-accent" : "border-border text-fg-dim hover:bg-bg-hover hover:text-fg"
      } ${className}`}
    >
      {label}
    </button>
  );
}
