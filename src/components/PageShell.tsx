import type { ReactNode } from "react";

/**
 * The height/overflow chain for a route page, in one place.
 *
 * Every page is rendered directly inside `<main>` (App.tsx), which is a bounded
 * `h-full` flex column with no overflow of its own, sitting inside a root that
 * is `overflow-hidden`. That means a page must build its own scroll container -
 * and if any flex item in the chain omits `min-h-0`, its automatic minimum size
 * is its content height, so it grows past the bound instead of being clamped,
 * every `overflow-y-auto` below it goes inert, and the excess is silently
 * clipped with no scrollbar anywhere.
 *
 * That is exactly what went wrong on Skills, Plugins and Agents. Getting it
 * right per page did not hold, so pages use this instead.
 *
 * Chat is the one exception: it manages its own virtualized scrolling.
 */
export function PageShell({
  title,
  subtitle,
  icon,
  actions,
  toolbar,
  children,
  maxWidth = "max-w-3xl",
  bodyScrolls = true,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  /** Buttons shown beside the title. Wrap to their own row under `sm`. */
  actions?: ReactNode;
  /** Optional row below the header that stays fixed while the body scrolls. */
  toolbar?: ReactNode;
  children: ReactNode;
  maxWidth?: string;
  /**
   * False when the page owns its own internal scrolling - a virtualized list or
   * a two-pane layout - so there is never more than one scroll container per axis.
   */
  bodyScrolls?: boolean;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4 pt-5 sm:px-6 sm:pt-6">
        <div className={`mx-auto w-full ${maxWidth}`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h1 data-ui="display" className="flex items-center gap-2 font-display text-2xl font-normal tracking-[-0.02em] sm:text-3xl">
                {icon}
                <span className="truncate">{title}</span>
              </h1>
              {subtitle && <p className="mt-0.5 text-sm leading-5 text-fg-dim">{subtitle}</p>}
            </div>
            {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
          </div>
          {toolbar && <div className="mt-3">{toolbar}</div>}
        </div>
      </div>

      {bodyScrolls ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6 pt-4 sm:px-6">
          <div className={`mx-auto w-full ${maxWidth}`}>{children}</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-4 sm:px-6">
          <div className={`mx-auto flex w-full min-h-0 flex-1 flex-col ${maxWidth}`}>{children}</div>
        </div>
      )}
    </div>
  );
}
