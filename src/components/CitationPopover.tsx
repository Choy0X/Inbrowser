import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SearchResult } from "../lib/types";

interface CitationPopoverProps {
  result: SearchResult;
  index: number;
  onOpen: () => void;
}

/** Max width of the popover card (see styles.css — matches max-w-xs). */
const POPOVER_MAX_W = 320;
const EDGE = 8;
const GAP = 16;

/** Rich hover popover for inline citation badges.
 *
 * Renders the badge as the trigger, shows a dark product-chrome card on hover,
 * and keeps the card anchored to the badge even while the viewport scrolls.
 * The card position is clamped to screen edges so it never overflows on the
 * right or bottom of narrow windows.
 */
export function CitationPopover({ result, index, onOpen }: CitationPopoverProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [flip, setFlip] = useState(false);
  const timerRef = useRef<number | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const measure = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cx = Math.min(
      Math.max(r.left + r.width / 2, POPOVER_MAX_W / 2 + EDGE),
      vw - POPOVER_MAX_W / 2 - EDGE,
    );
    const fitsBelow = r.bottom + GAP + 210 <= vh;
    setFlip(!fitsBelow);
    setPos({
      left: cx,
      top: fitsBelow ? r.bottom + GAP : r.top - GAP,
    });
  }, []);

  const show = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      measure();
      setOpen(true);
    }, 200);
  }, [measure]);

  const hide = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setOpen(false);
  }, []);

  // Keep the card glued to the badge while scrolling / resizing.
  useEffect(() => {
    if (!open) return;
    const onMove = () => measure();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, measure]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return (
    <span
      ref={triggerRef}
      className="inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <button
        type="button"
        onClick={onOpen}
        className="citation-badge"
        aria-label={`Open source ${index}`}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {index}
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            role="dialog"
            className="fixed z-[100]"
            style={{
              left: pos.left,
              top: pos.top,
              transform: flip ? "translate(-50%, -100%)" : "translate(-50%, 0)",
            }}
          >
            <div className="citation-card">
              <div className="p-3">
                <div className="flex items-start gap-2">
                  {result.faviconUrl && (
                    <img
                      src={result.faviconUrl}
                      alt=""
                      className="h-4 w-4 shrink-0 rounded"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <a
                      href={result.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={onOpen}
                      className="block truncate text-xs font-medium text-accent hover:underline"
                    >
                      {result.title}
                    </a>
                    {result.displayUrl && (
                      <span className="mt-0.5 block truncate text-[10px] text-on-night/60">
                        {result.displayUrl}
                      </span>
                    )}
                    {result.snippet && (
                      <span className="mt-1.5 line-clamp-2 block text-xs leading-4 text-on-night/70">
                        {result.snippet}
                      </span>
                    )}
                  </div>
                </div>
                <a
                  href={result.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={onOpen}
                  className="mt-2 inline-flex items-center gap-0.5 text-[11px] text-accent hover:underline"
                >
                  <span aria-hidden className="inline text-[12px] leading-none">↗</span>
                  Open source
                </a>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}