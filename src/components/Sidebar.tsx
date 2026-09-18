import { useMemo, useState } from "react";
import { NavLink } from "./ui/NavLink";
import {
  Bot,
  Clock,
  Info,
  Menu,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Plus,
  Shield,
  Sparkles,
  Store,
  Search,
  Settings,
  Trash2,
  Wand2,
} from "lucide-react";
import type { Conversation } from "../lib/types";
import type { SettingsTab } from "./SettingsModal";
import { Mark } from "./Mark";
import { APP_NAME } from "../lib/appConfig";
import { Tooltip } from "./Tooltip";
import { ConfirmDialog } from "./Dialog";
import { SidebarMoreMenu } from "./SidebarMoreMenu";

function dayLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86400000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return "Previous 7 days";
  if (diffDays < 30) return "Previous 30 days";
  return "Older";
}

interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  collapsed: boolean;
  tasksViewActive: boolean;
  libraryViewActive: boolean;
  storeViewActive: boolean;
  agentsViewActive: boolean;
  onToggleCollapse: () => void;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onDeleteAll: () => void;
  onRename: (id: string, title: string) => void;
  onOpenSettings: (tab: SettingsTab) => void;
  status: "checking" | "ok" | "error";
  providerSummary: string;
  pendingMemoryCount: number;
  updateAvailable: boolean;
}

export function Sidebar({
  conversations,
  activeId,
  collapsed,
  tasksViewActive,
  libraryViewActive,
  storeViewActive,
  agentsViewActive,
  onToggleCollapse,
  onNewChat,
  onSelect,
  onDelete,
  onDeleteAll,
  onRename,
  onOpenSettings,
  status,
  providerSummary,
  pendingMemoryCount,
  updateAvailable,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Conversation | "all" | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  const hasChats = conversations.some((c) => !c.temporary && c.messages.length > 0);

  const grouped = useMemo(() => {
    const visible = conversations.filter((c) => !c.temporary && c.messages.length > 0);
    const filtered = query.trim()
      ? visible.filter((c) => c.title.toLowerCase().includes(query.trim().toLowerCase()))
      : [...visible].sort((a, b) => b.updatedAt - a.updatedAt);
    const map = new Map<string, Conversation[]>();
    for (const convo of filtered) {
      const label = dayLabel(convo.updatedAt);
      const arr = map.get(label) ?? [];
      if (arr.length === 0) map.set(label, arr);
      arr.push(convo);
    }
    return [...map.entries()];
  }, [conversations, query]);

  const startRename = (convo: Conversation) => {
    setRenamingId(convo.id);
    setDraft(convo.title);
  };

  const commitRename = () => {
    if (renamingId) onRename(renamingId, draft.trim() || "New chat");
    setRenamingId(null);
  };

  const closeMobile = () => setMobileOpen(false);

  const sidebarBody = (
    <>
      <div className="flex items-center gap-2 px-4 pt-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Mark size={18} className="shrink-0 text-accent" />
          <span className="truncate font-display text-lg tracking-[-0.02em]">{APP_NAME}</span>
        </div>
        <Tooltip label="Collapse sidebar">
          <button
            type="button"
            onClick={() => {
              onToggleCollapse();
              closeMobile();
            }}
            className="rounded-full p-2 text-fg-faint hover:bg-canvas hover:text-fg"
          >
            <PanelLeftClose size={16} />
          </button>
        </Tooltip>
      </div>

      <div className="px-3 pt-3">
        <button
          type="button"
          onClick={() => {
            onNewChat();
            closeMobile();
          }}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-3 py-2.5 font-mono text-sm font-medium uppercase tracking-[0.06em] text-on-accent transition-colors hover:bg-accent-hover"
        >
          <Plus size={16} />
          New chat
        </button>
      </div>

      <div className="px-3 pt-2">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-canvas px-3 py-2">
          <Search size={14} className="text-fg-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            className="w-full bg-transparent text-sm outline-none placeholder:text-fg-faint"
          />
        </div>
      </div>

      <nav className="mt-3 flex-1 space-y-3 overflow-y-auto px-3 pb-3">
        {grouped.length === 0 && (
          <p className="px-2 pt-4 text-center text-xs text-fg-faint">
            {query ? "No chats found." : "No conversations yet."}
          </p>
        )}
        {grouped.map(([label, list]) => (
          <div key={label}>
            <div data-ui="meta" className="px-2 py-1.5 text-[11px] font-medium text-fg-faint">
              {label}
            </div>
            <div className="space-y-0.5">
              {list.map((convo) => (
                <div
                  key={convo.id}
                  data-ui="nav-item"
                  data-active={convo.id === activeId ? "" : undefined}
                  className={`group flex items-center transition-colors ${
                    convo.id === activeId
                      ? "border-accent bg-bg-hover"
                      : "border-transparent hover:bg-bg-hover/60"
                  }`}
                >
                  {renamingId === convo.id ? (
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      className="mx-2 my-1 w-full rounded bg-canvas px-2 py-1 text-sm outline-none"
                    />
                  ) : (
                    <>
                      <Tooltip label={convo.title}>
                        <button
                          type="button"
                          onClick={() => {
                            onSelect(convo.id);
                            closeMobile();
                          }}
                          className="min-w-0 flex-1 truncate px-3 py-2 text-left text-sm"
                        >
                          {convo.title}
                        </button>
                      </Tooltip>
                      <div className="flex shrink-0 items-center gap-0.5 pr-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                        <Tooltip label="Rename">
                          <button
                            type="button"
                            onClick={() => startRename(convo)}
                            className="rounded p-1 text-fg-faint hover:text-fg"
                          >
                            <Pencil size={13} />
                          </button>
                        </Tooltip>
                        <Tooltip label="Delete">
                          <button
                            type="button"
                            onClick={() => setPendingDelete(convo)}
                            className="rounded p-1 text-fg-faint hover:text-error"
                          >
                            <Trash2 size={13} />
                          </button>
                        </Tooltip>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-border px-3 py-2">
        {/* Regrouped: Library is what you author, Store is what you install.
            Browsing used to be split across two unrelated pages while
            authoring was split across two more. */}
        {/* Real <a href> rather than buttons: this is the app's own link graph,
            so a crawler can reach every section from any page and a visitor can
            middle-click one into a new tab. NavLink still routes a plain click
            through the client router. */}
        {(
          [
            ["Library", "library", "/library", libraryViewActive, Wand2],
            ["Agents", "agents", "/agents", agentsViewActive, Bot],
            ["Store", "store", "/store", storeViewActive, Store],
            ["Automations", "tasks", "/tasks", tasksViewActive, Clock],
          ] as [string, string, string, boolean, typeof Wand2][]
        ).map(([label, key, to, active, Icon]) => (
          <Tooltip key={key} label={label}>
            <NavLink
              to={to}
              onClick={closeMobile}
              data-ui="nav-item"
              data-active={active ? "" : undefined}
              className={`mt-1 flex w-full items-center gap-2 px-2 text-sm transition-colors ${
                active
                  ? "border-accent bg-bg-hover text-fg"
                  : "border-transparent text-fg-dim hover:bg-bg-hover/60 hover:text-fg"
              }`}
            >
              <Icon size={16} className="shrink-0" />
              {label}
            </NavLink>
          </Tooltip>
        ))}
      </div>

      <div className="flex items-center gap-2 border-t border-border px-3 py-3">
        <Tooltip label={providerSummary}>
          <button
            type="button"
            onClick={() => {
              onOpenSettings("providers");
              closeMobile();
            }}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-fg-dim hover:bg-bg-hover hover:text-fg"
          >
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                status === "ok"
                  ? "bg-success"
                  : status === "error"
                    ? "bg-error"
                    : "animate-pulse bg-amber"
              }`}
            />
            <span className="truncate">{providerSummary}</span>
          </button>
        </Tooltip>
        <div className="flex shrink-0 items-center gap-1">
          <SidebarMoreMenu
            trigger={(open) => (
              <Tooltip label="More">
                <span
                  data-active={open ? "" : undefined}
                  className="relative flex rounded-full border border-border bg-canvas p-2 text-fg-faint hover:bg-bg-hover hover:text-fg data-[active]:bg-bg-hover data-[active]:text-fg"
                >
                  <MoreHorizontal size={16} />
                  {updateAvailable && (
                    <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent" />
                  )}
                </span>
              </Tooltip>
            )}
            items={[
              {
                icon: <Sparkles size={16} />,
                label: "Change logs",
                to: "/changelog",
                onSelect: closeMobile,
                badge: updateAvailable && (
                  <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-accent" />
                ),
              },
              {
                icon: <Sparkles size={16} />,
                label: "Discover features",
                to: "/features",
                onSelect: closeMobile,
              },
              {
                icon: <Shield size={16} />,
                label: "Privacy policy",
                to: "/privacy",
                onSelect: closeMobile,
              },
              {
                icon: <Info size={16} />,
                label: "About",
                to: "/about",
                onSelect: closeMobile,
              },
              ...(hasChats
                ? [
                    {
                      icon: <Trash2 size={16} />,
                      label: "Delete all chats",
                      tone: "danger" as const,
                      onSelect: () => {
                        setPendingDelete("all");
                        closeMobile();
                      },
                    },
                  ]
                : []),
            ]}
          />
          <Tooltip label="Settings">
            <button
              type="button"
              onClick={() => {
                onOpenSettings(pendingMemoryCount > 0 ? "memory" : "general");
                closeMobile();
              }}
              className="relative rounded-full border border-border bg-canvas p-2 text-fg-faint hover:bg-bg-hover hover:text-fg"
            >
              <Settings size={16} />
              {pendingMemoryCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent" />
              )}
            </button>
          </Tooltip>
        </div>
      </div>
    </>
  );

  return (
    <>
      <Tooltip label="Open sidebar">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          className="fixed left-3 top-3 z-20 flex items-center justify-center rounded-full border border-border bg-bg-elevated p-2 text-fg-dim shadow-lift md:hidden"
        >
          <Menu size={16} />
        </button>
      </Tooltip>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <div className="absolute inset-0 bg-overlay/60" onClick={closeMobile} />
          <div className="relative z-10 flex h-full w-72 max-w-[80vw] flex-col overflow-hidden border-r border-border bg-bg-elevated shadow-lift">
            {sidebarBody}
          </div>
        </div>
      )}

      <aside
        data-ui="rail"
        style={{ width: collapsed ? 0 : "var(--rail-w)" }}
        className="relative hidden h-full shrink-0 overflow-hidden border-r border-border bg-bg-elevated transition-[width] duration-200 md:block"
      >
        <div style={{ width: "var(--rail-w)" }} className="flex h-full flex-col">
          {sidebarBody}
        </div>
      </aside>

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete === "all") onDeleteAll();
          else if (pendingDelete) onDelete(pendingDelete.id);
        }}
        title={pendingDelete === "all" ? "Delete all chats?" : "Delete conversation?"}
        message={
          pendingDelete === "all" ? (
            "Every conversation will be permanently removed."
          ) : pendingDelete ? (
            <>
              <span className="line-clamp-2">{pendingDelete.title}</span> will be permanently removed.
            </>
          ) : null
        }
      />
    </>
  );
}
