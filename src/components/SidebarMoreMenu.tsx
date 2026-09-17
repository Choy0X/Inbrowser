import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { NavLink } from "./ui/NavLink";

interface MenuItem {
  icon: ReactNode;
  label: ReactNode;
  onSelect: () => void;
  /**
   * When the item navigates somewhere, its route. The item then renders as a
   * real `<a href>` so it is a crawlable link and can be opened in a new tab,
   * with `onSelect` still handling a plain click. Items that only act (delete
   * all chats) leave it unset.
   */
  to?: string;
  tone?: "default" | "danger";
  badge?: ReactNode;
}

const GAP = 8;
const EDGE = 8;
const PANEL_W = 208;

/**
 * Click-triggered overflow menu, anchored above its trigger since the
 * trigger sits at the bottom of the sidebar. Adapts the portal +
 * getBoundingClientRect approach from CitationPopover for a click (not
 * hover) interaction with outside-click/Escape dismissal.
 */
export function SidebarMoreMenu({ trigger, items }: { trigger: (open: boolean) => ReactNode; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.min(Math.max(r.left, EDGE), window.innerWidth - PANEL_W - EDGE);
    setPos({ left, top: r.top - GAP });
  }, []);

  const toggle = () => {
    if (!open) measure();
    setOpen((o) => !o);
  };

  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onMove = () => measure();
    document.addEventListener("pointerdown", onDocPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, measure]);

  return (
    <>
      <button ref={triggerRef} type="button" onClick={toggle} aria-haspopup="menu" aria-expanded={open}>
        {trigger(open)}
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            role="menu"
            className="fixed z-[100] w-52 rounded-lg border border-border bg-bg-elevated p-1 shadow-lift"
            style={{ left: pos.left, top: pos.top, transform: "translateY(-100%)" }}
          >
            {items.map((item, i) => {
              const className = `flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors ${
                item.tone === "danger"
                  ? "text-fg-dim hover:bg-error/10 hover:text-error"
                  : "text-fg-dim hover:bg-bg-hover hover:text-fg"
              }`;
              const body = (
                <>
                  <span className="relative shrink-0">
                    {item.icon}
                    {item.badge}
                  </span>
                  {item.label}
                </>
              );
              const select = () => {
                setOpen(false);
                item.onSelect();
              };

              return item.to ? (
                <NavLink key={i} to={item.to} role="menuitem" onClick={select} className={className}>
                  {body}
                </NavLink>
              ) : (
                <button key={i} type="button" role="menuitem" onClick={select} className={className}>
                  {body}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
