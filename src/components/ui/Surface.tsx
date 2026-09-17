import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * Surfaces, grouping and status.
 *
 * The elevation vocabulary is deliberately tiny - a card, a hairline, and two
 * shadows - because every skin defines those tokens and nothing else. Screens
 * inventing their own borders and shadows is what made the app look like
 * several different products.
 */

export function Card({
  children,
  className = "",
  padded = true,
  as: Tag = "div",
  selected = false,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
  as?: "div" | "section" | "li" | "button";
  /** Composes the "this is the selected one of a set" treatment, e.g. a picked row in a list. */
  selected?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Tag
      data-ui="surface"
      data-active={selected ? "" : undefined}
      className={`border shadow-soft ${
        selected ? "border-accent bg-accent/5" : "border-border bg-bg-elevated"
      } ${padded ? "p-4" : ""} ${className}`}
      {...(rest as Record<string, unknown>)}
    >
      {children}
    </Tag>
  );
}

/** A titled block inside a settings-style page. */
export function Section({
  title,
  description,
  actions,
  children,
  className = "",
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div data-ui="surface" className={`border border-border-subtle bg-canvas p-4 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          {description && <div className="mt-0.5 text-xs leading-5 text-fg-dim">{description}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "error" | "info";

const TONES: Record<BadgeTone, string> = {
  neutral: "border border-border text-fg-faint",
  accent: "bg-accent/10 text-accent",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  error: "bg-error/15 text-error",
  info: "bg-teal/15 text-teal",
};

export function Badge({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-normal ${TONES[tone]} ${className}`}>
      {children}
    </span>
  );
}

/**
 * Segmented control. Used for every in-page tab strip so they all behave the
 * same and pick up the skin's radius.
 */
export function Tabs<T extends string>({
  value,
  onChange,
  options,
  className = "",
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: ReactNode; badge?: ReactNode }[];
  className?: string;
}) {
  return (
    <div
      role="tablist"
      data-ui="tabs"
      className={`flex items-center rounded-lg border border-border p-0.5 ${className}`}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            data-ui="tab"
            data-active={active ? "" : undefined}
            onClick={() => onChange(option.value)}
            className={`flex h-9 items-center gap-1 rounded-md px-2.5 text-xs font-medium transition-colors ${
              active
                ? "bg-canvas text-fg shadow-soft ring-1 ring-inset ring-border"
                : "text-fg-dim hover:text-fg"
            }`}
          >
            {option.label}
            {option.badge != null && <span className="text-fg-faint">{option.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * What a list shows when it has nothing. An empty region with no explanation
 * reads as a bug, so this always takes a reason and usually an action.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className = "",
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-10 text-center ${className}`}
    >
      {icon && <span className="text-fg-faint">{icon}</span>}
      <p className="text-sm text-fg-dim">{title}</p>
      {description && <p className="max-w-sm text-xs leading-5 text-fg-faint">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/** Determinate when a fraction is known, indeterminate when it isn't. */
export function Progress({
  value,
  label,
  className = "",
}: {
  value?: number;
  label?: ReactNode;
  className?: string;
}) {
  const pct = typeof value === "number" ? Math.max(0, Math.min(100, Math.round(value * 100))) : null;
  return (
    <div className={className}>
      <div
        role="progressbar"
        aria-valuenow={pct ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 w-full overflow-hidden rounded-full bg-canvas"
      >
        <div
          className={`h-full rounded-full bg-accent transition-[width] ${pct === null ? "animate-pulse" : ""}`}
          style={{ width: pct === null ? "35%" : `${pct}%` }}
        />
      </div>
      {label && <p className="mt-1 truncate text-[11px] text-fg-faint">{label}</p>}
    </div>
  );
}
