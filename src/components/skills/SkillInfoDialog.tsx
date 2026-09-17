import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { FileCode2, FileText, Image as ImageIcon, Wand2, X } from "lucide-react";
import type { Skill, SkillResource } from "../../lib/skills";
import { skillSlug } from "../../lib/skills";
import { getSkillResources } from "../../lib/skillstore";
import { Markdown } from "../Markdown";
import { Tabs } from "../ui";

type Tab = "overview" | "files";

const MARKDOWN_EXT = new Set(["md", "markdown"]);

/** oneDark's own canonical background — applied uniformly across the code
 *  viewer's wrapper, `<pre>`, and `<code>` so nothing shows a second,
 *  slightly different shade from whatever sits behind it (the theme sets
 *  its own background on both the outer and inner tags; overriding only
 *  the outer one via `customStyle` left the inner tag's shade showing
 *  through as a visible seam). */
const CODE_BG = "hsl(220, 13%, 18%)";

/** Maps a file extension to a Prism language id for syntax highlighting. */
const EXT_LANGUAGE: Record<string, string> = {
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "tsx",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", swift: "swift", kt: "kotlin", scala: "scala",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  css: "css", scss: "scss", less: "less",
  html: "markup", htm: "markup", xml: "markup", svg: "markup",
  sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell",
  sql: "sql", diff: "diff", patch: "diff", ini: "ini", conf: "ini",
  dockerfile: "docker", graphql: "graphql", lua: "lua", r: "r",
};

function extOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

/** Read-only, type-aware preview — never an editor. Markdown renders rich,
 *  known code extensions get syntax highlighting, everything else falls
 *  back to a plain monospace view; images render inline. */
function ResourcePreview({ resource }: { resource: SkillResource }) {
  if (resource.kind === "image") {
    return (
      <div className="flex h-full items-center justify-center overflow-auto p-4">
        {resource.dataUrl ? (
          <img src={resource.dataUrl} alt={resource.path} className="max-h-full max-w-full rounded-lg" />
        ) : (
          <p className="text-sm text-fg-faint">No preview available.</p>
        )}
      </div>
    );
  }
  if (resource.kind === "binary") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-sm text-fg-faint">
        <FileCode2 size={22} />
        Binary file — no preview available.
      </div>
    );
  }

  const ext = extOf(resource.path);
  if (MARKDOWN_EXT.has(ext)) {
    return (
      <div className="h-full overflow-auto px-5 py-4">
        <Markdown text={resource.text || "*(empty file)*"} />
      </div>
    );
  }
  const language = EXT_LANGUAGE[ext];
  if (language) {
    return (
      <div className="h-full overflow-auto" style={{ background: CODE_BG }}>
        <SyntaxHighlighter
          language={language}
          style={oneDark}
          PreTag="div"
          customStyle={{ margin: 0, minHeight: "100%", background: CODE_BG, fontSize: 12, padding: "16px" }}
          codeTagProps={{ style: { background: CODE_BG, display: "block" } }}
        >
          {resource.text || ""}
        </SyntaxHighlighter>
      </div>
    );
  }
  return (
    <pre className="h-full overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-[12px] leading-5 text-fg">
      {resource.text || "(empty file)"}
    </pre>
  );
}

/**
 * claude.ai-inspired skill detail popup: header (icon + name + byline),
 * Overview / Files tabs, a two-pane file browser for bundled resources.
 * Read-only — management actions (enable/disable, delete) live in the
 * dedicated Skills page, not this quick-reference popup.
 */
export function SkillInfoDialog({
  skill,
  onClose,
}: {
  skill: Skill | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<Element | null>(null);

  const open = !!skill;
  // Resource bodies live in IndexedDB; the skill record carries only a
  // path/kind manifest, so previews load content on demand.
  const [resources, setResources] = useState<SkillResource[]>([]);
  const selected = resources.find((r) => r.path === selectedPath) ?? resources[0] ?? null;

  useEffect(() => {
    if (open) {
      setTab("overview");
      setSelectedPath(null);
    }
  }, [open, skill?.id]);

  useEffect(() => {
    if (!open || !skill) {
      setResources([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const stored = await getSkillResources(skill.id).catch(() => []);
      if (cancelled) return;
      setResources(stored.length > 0 ? stored : (skill.resources ?? []));
    })();
    return () => {
      cancelled = true;
    };
  }, [open, skill]);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const toRestore = restoreRef.current;
      if (toRestore instanceof HTMLElement) toRestore.focus();
    };
  }, [open, onClose]);

  if (!skill) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-overlay/60" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="relative z-10 flex h-[min(760px,88vh)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-bg-elevated shadow-lift outline-none"
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 pb-4 pt-5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent">
              <Wand2 size={19} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-base font-medium">{skill.name}</h2>
                {skill.builtin && (
                  <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-fg-faint">
                    Built-in
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate text-xs text-fg-faint">
                <code className="text-fg-dim">/{skillSlug(skill)}</code>
                {!skill.enabled && <span className="ml-2 text-amber">Disabled</span>}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-full border border-border bg-canvas p-1.5 text-fg-dim hover:bg-bg-hover hover:text-fg"
          >
            <X size={16} />
          </button>
        </div>

        <div className="shrink-0 border-b border-border px-5 py-2.5">
          <Tabs
            value={tab}
            onChange={setTab}
            options={[
              { value: "overview", label: "Overview" },
              ...(resources.length > 0
                ? [{ value: "files" as Tab, label: `Files · ${resources.length}` }]
                : []),
            ]}
          />
        </div>

        <div className="min-h-0 flex-1">
          {tab === "overview" ? (
            <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
              <div>
                <h3 className="mb-1.5 text-xs font-medium uppercase tracking-[1px] text-fg-faint">
                  Description
                </h3>
                <p className="text-sm leading-6 text-fg">
                  {skill.description || "No description provided."}
                </p>
              </div>
              <div>
                <h3 className="mb-1.5 text-xs font-medium uppercase tracking-[1px] text-fg-faint">
                  Instructions
                </h3>
                <div className="max-h-[28rem] overflow-y-auto rounded-lg border border-border bg-canvas px-5 py-4">
                  <Markdown text={skill.instructions || "*No instructions provided.*"} />
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-full">
              <div className="w-56 shrink-0 overflow-y-auto border-r border-border py-1.5">
                {resources.map((r) => {
                  const Icon =
                    r.kind === "image" ? ImageIcon : EXT_LANGUAGE[extOf(r.path)] ? FileCode2 : FileText;
                  return (
                    <button
                      key={r.path}
                      type="button"
                      onClick={() => setSelectedPath(r.path)}
                      className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs transition-colors ${
                        selected?.path === r.path
                          ? "bg-accent/15 text-accent"
                          : "text-fg-dim hover:bg-bg-hover hover:text-fg"
                      }`}
                    >
                      <Icon size={12} className="shrink-0" />
                      <span className="truncate font-mono">{r.path}</span>
                    </button>
                  );
                })}
              </div>
              <div className="min-w-0 flex-1 overflow-hidden">
                {selected ? (
                  <>
                    <div className="border-b border-border-subtle px-4 py-2 font-mono text-[11px] text-fg-faint">
                      /{selected.path}
                    </div>
                    <div className="h-[calc(100%-33px)]">
                      <ResourcePreview resource={selected} />
                    </div>
                  </>
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-fg-faint">
                    No file selected
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
