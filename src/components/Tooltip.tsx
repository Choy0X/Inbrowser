import {
  cloneElement,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";

/** Writes `value` into any ref shape (callback or object) without clobbering it. */
function setRef<T>(ref: Ref<T> | null | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

interface TooltipProps {
  label: ReactNode;
  children: ReactElement;
  /** Which side of the trigger the tooltip appears on. Flipped automatically
   * if there isn't room. */
  side?: "top" | "bottom";
  /** Hover/focus delay in ms before the tooltip appears. */
  delay?: number;
}

const VIEWPORT_MARGIN = 8;

/**
 * Custom styled tooltip that replaces the browser-native `title` tooltip.
 * Renders the trigger untouched (events are attached via cloning) and paints
 * the popover through a portal with fixed positioning, so it never disturbs
 * flex layout, absolute positioning, or overflow containers.
 */
export function Tooltip({ label, children, side = "top", delay = 300 }: TooltipProps) {
  const [open, setOpen] = useState(false);
  // Trigger's own rect, captured on show; the tooltip's on-screen position is
  // derived from this plus the tooltip's *measured* size (see below), so it
  // never depends on the trigger's position alone.
  const [anchor, setAnchor] = useState<{ top: number; bottom: number; centerX: number } | null>(
    null
  );
  const [coords, setCoords] = useState<{ top: number; left: number; placement: "top" | "bottom" } | null>(
    null
  );
  const timerRef = useRef<number | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);

  const schedule = (show: boolean) => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    if (!show) {
      setOpen(false);
      setCoords(null);
      return;
    }
    timerRef.current = window.setTimeout(() => {
      const el = triggerRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        setAnchor({ top: r.top, bottom: r.bottom, centerX: r.left + r.width / 2 });
      }
      setOpen(true);
    }, delay);
  };

  // Runs after the tooltip mounts but before the browser paints, so the
  // corrected, viewport-clamped position replaces the naive centered guess
  // with no visible flash. Without this a tooltip near any screen edge (the
  // sidebar's left-aligned rows, top-row icons, ...) renders partly or
  // wholly off-screen instead of shifting to stay visible.
  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const tip = tooltipRef.current;
    if (!tip) return;
    const rect = tip.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = anchor.centerX;
    const half = rect.width / 2;
    if (left - half < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN + half;
    if (left + half > vw - VIEWPORT_MARGIN) left = vw - VIEWPORT_MARGIN - half;

    let placement = side;
    if (placement === "top" && anchor.top - rect.height - VIEWPORT_MARGIN < 0) {
      placement = "bottom";
    } else if (placement === "bottom" && anchor.bottom + rect.height + VIEWPORT_MARGIN > vh) {
      placement = "top";
    }

    const top = placement === "top" ? anchor.top - 8 : anchor.bottom + 8;
    setCoords((prev) =>
      prev && prev.top === top && prev.left === left && prev.placement === placement
        ? prev
        : { top, left, placement }
    );
  }, [open, anchor, side]);

  const originalOnClick = (children.props as { onClick?: (e: MouseEvent) => void }).onClick;
  // Preserve whatever ref the child already carries (e.g. a forwardRef'd
  // IconButton exposing its DOM node to its own caller) — cloneElement would
  // otherwise silently replace it with ours.
  const originalRef = (children as unknown as { ref?: Ref<HTMLElement> }).ref;
  const trigger = cloneElement(children, {
    ref: ((node: HTMLElement | null) => {
      triggerRef.current = node;
      setRef(originalRef, node);
    }) as never,
    onMouseEnter: (() => schedule(true)) as never,
    onMouseLeave: (() => schedule(false)) as never,
    onFocus: (() => schedule(true)) as never,
    onBlur: (() => schedule(false)) as never,
    // Clicking a trigger doesn't fire mouseleave/blur (pointer stays over the
    // button, which often keeps focus too), so without this the tooltip can
    // stay open and render above whatever the click just opened.
    onClick: ((e: MouseEvent) => {
      schedule(false);
      originalOnClick?.(e);
    }) as never,
  });

  // Placed at the naive (unclamped) center first render so the layout
  // effect above has a real box to measure; clamped coords take over before
  // paint once available.
  const placement = coords?.placement ?? side;
  const left = coords?.left ?? anchor?.centerX ?? 0;
  const top = coords ? coords.top : placement === "top" ? (anchor?.top ?? 0) - 8 : (anchor?.bottom ?? 0) + 8;

  return (
    <>
      {trigger}
      {open &&
        anchor &&
        createPortal(
          <span
            ref={tooltipRef}
            role="tooltip"
            className={`pointer-events-none fixed z-[100] max-w-[16rem] -translate-x-1/2 overflow-hidden text-ellipsis whitespace-nowrap rounded-lg border border-border-subtle bg-night px-2 py-1 text-xs font-medium text-on-night shadow-lift ${
              placement === "top" ? "-translate-y-full" : ""
            }`}
            style={{ left, top, visibility: coords ? "visible" : "hidden" }}
          >
            {label}
          </span>,
          document.body
        )}
    </>
  );
}
