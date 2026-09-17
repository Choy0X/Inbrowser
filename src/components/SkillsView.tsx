import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookMarked,
  ChevronLeft,
  Check,
  Copy,
  CopyPlus,
  Download,
  LayoutGrid,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import type { Skill } from "../lib/skills";
import { exportSkillsZip, newSkill, parseSkillFileAll, skillSlug } from "../lib/skills";
import { deleteSkillResources, getSkillResources, putSkillResources } from "../lib/skillstore";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useDebounced } from "../lib/useDebounced";
import { Toggle } from "./Toggle";
import { Tooltip } from "./Tooltip";
import { SkillFiles } from "./SkillFiles";
import { Tabs, Input, Textarea, SearchInput, EmptyState } from "./ui";
import { APP_NAME, APP_SLUG } from "../lib/appConfig";

interface SkillsViewProps {
  skills: Skill[];
  onSaveSkills: (skills: Skill[]) => void;
}

/** Draft mirror of a skill being edited in the detail pane. */
interface EditorState {
  id: string | null;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  builtin?: boolean;
}

export function SkillsWorkbench({ skills, onSaveSkills }: SkillsViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saved, setSaved] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const [detailTab, setDetailTab] = useState<"overview" | "content">("overview");
  const [listCollapsed, setListCollapsed] = useState(false);

  const debouncedQuery = useDebounced(query, 120);

  /**
   * Lowercased haystack per skill, rebuilt only when the skills change.
   * Searching used to lowercase every skill's full instructions body on every
   * keystroke, which is O(total bytes of all skills) per character typed.
   */
  const searchIndex = useMemo(() => {
    const map = new Map<string, string>();
    for (const skill of skills) {
      map.set(skill.id, [skill.name, skill.description, skill.instructions].join("\n").toLowerCase());
    }
    return map;
  }, [skills]);

  const filtered = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((s) => (searchIndex.get(s.id) ?? "").includes(q));
  }, [skills, debouncedQuery, searchIndex]);

  const selected = useMemo(() => skills.find((s) => s.id === selectedId) ?? null, [skills, selectedId]);
  const enabledCount = useMemo(() => skills.reduce((n, s) => n + (s.enabled ? 1 : 0), 0), [skills]);

  /** Below md the list and the editor cannot both fit, so one is shown at a time. */
  const detailOpen = Boolean(editor || selected);
  const closeDetail = () => {
    setEditor(null);
    setSelectedId(null);
  };

  const listScrollRef = useRef<HTMLUListElement>(null);
  const listVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listScrollRef.current,
    estimateSize: () => 72,
    getItemKey: (index) => filtered[index]?.id ?? index,
    overscan: 8,
  });
  useEffect(() => {
    if (!listCollapsed) listVirtualizer.measure();
  }, [filtered, listVirtualizer, listCollapsed]);

  const upsert = (next: Skill) => {
    const already = skills.some((s) => s.id === next.id);
    const updated = already
      ? skills.map((s) => (s.id === next.id ? next : s))
      : [...skills, next];
    onSaveSkills(updated);
    setSelectedId(next.id);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1200);
  };

  const beginNew = () => {
    setEditor({
      id: null,
      name: "",
      description: "",
      instructions: "",
      enabled: true,
    });
    setSelectedId(null);
  };

  const beginEdit = (skill: Skill) => {
    setEditor({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      enabled: skill.enabled,
      builtin: skill.builtin,
    });
    setSelectedId(skill.id);
    setDetailTab("overview");
  };

  /** Persist a skill's resources snapshot without extra side effects (used by file editor). */
  const persistSkill = (next: Skill) => {
    const already = skills.some((s) => s.id === next.id);
    onSaveSkills(already ? skills.map((s) => (s.id === next.id ? next : s)) : [...skills, next]);
  };

  const saveEditor = () => {
    if (!editor || !editor.name.trim() || !editor.instructions.trim()) return;
    if (editor.id) {
      const existing = skills.find((s) => s.id === editor.id);
      if (!existing) return;
      upsert({
        ...existing,
        name: editor.name.trim(),
        description: editor.description.trim(),
        instructions: editor.instructions.trim(),
        enabled: editor.enabled,
        slug: skillSlug(existing),
      });
    } else {
      const skill = newSkill(editor.name, editor.description, editor.instructions);
      skill.enabled = editor.enabled;
      upsert(skill);
    }
    setEditor(null);
  };

  const duplicate = (skill: Skill) => {
    const clone = newSkill(
      `${skill.name} (copy)`,
      skill.description,
      skill.instructions
    );
    clone.enabled = skill.enabled;
    upsert(clone);
  };

  const removeSkill = (id: string) => {
    const skill = skills.find((s) => s.id === id);
    if (skill?.builtin) return;
    onSaveSkills(skills.filter((s) => s.id !== id));
    void deleteSkillResources(id);
    if (selectedId === id) {
      setSelectedId(null);
      setEditor(null);
    }
  };

  const copyInstructions = async (skill: Skill) => {
    try {
      await navigator.clipboard.writeText(skill.instructions);
    } catch {
      /* ignore */
    }
  };

  const onImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    void (async () => {
      try {
        const buffer = await file.arrayBuffer();
        // A real skill archive routinely holds many SKILL.md files (an upstream
        // repo ships one per directory), so import every skill it contains
        // rather than an arbitrary first match.
        const parsed = parseSkillFileAll(buffer);
        const taken = new Set(skills.map((s) => s.name.toLowerCase()));
        const fresh = parsed.filter((s) => !taken.has(s.name.toLowerCase()));
        const skipped = parsed.length - fresh.length;
        if (fresh.length === 0) {
          setImportError(
            parsed.length === 1
              ? `A skill named "${parsed[0].name}" already exists.`
              : "Every skill in this file is already installed."
          );
          return;
        }
        for (const skill of fresh) {
          if (skill.resources && skill.resources.length > 0) {
            await putSkillResources(skill.id, skill.resources);
          }
        }
        onSaveSkills([...skills, ...fresh]);
        setImportError(
          skipped > 0
            ? `Imported ${fresh.length} skill${fresh.length === 1 ? "" : "s"}; skipped ${skipped} already installed.`
            : null
        );
      } catch (err) {
        setImportError(err instanceof Error ? err.message : "Invalid skill file");
      }
    })();
    e.target.value = "";
  };

  const exportZip = () => {
    void (async () => {
      // Resource bodies live in IndexedDB, so the exporter is handed a loader
      // rather than reading them off the skill records (which hold only a manifest).
      const blob = await exportSkillsZip(skills, getSkillResources);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${APP_SLUG}-skills.zip`;
      a.click();
      URL.revokeObjectURL(url);
    })();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-3 gap-y-2 text-xs text-fg-faint">
          <button
            type="button"
            onClick={beginNew}
            className="flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover"
          >
            <Plus size={14} /> New skill
          </button>
          <span>
            {enabledCount} enabled · {skills.length} total
          </span>
          <span className="flex items-center gap-3">
            <Tooltip label="Import a skill (.skill)">
              <button
                type="button"
                onClick={() => importRef.current?.click()}
                className="flex items-center gap-1 rounded-md border border-border bg-canvas px-2 py-1 text-fg-dim hover:bg-bg-hover hover:text-fg"
              >
                <Upload size={12} /> Import
              </button>
            </Tooltip>
            <Tooltip label="Export all skills as .skill files (.zip)">
              <button
                type="button"
                onClick={exportZip}
                className="flex items-center gap-1 rounded-md border border-border bg-canvas px-2 py-1 text-fg-dim hover:bg-bg-hover hover:text-fg"
              >
                <Download size={12} /> Export
              </button>
            </Tooltip>
          </span>
        </div>
        <input
          ref={importRef}
          type="file"
          accept=".skill,text/markdown"
          className="hidden"
          onChange={onImportFile}
        />
        {importError && <p className="mt-2 text-xs text-error">{importError}</p>}

        <div className="mt-3 flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
          {/* Left pane: searchable list */}
          <div
            className={
              listCollapsed
                ? "hidden"
                : `${detailOpen ? "hidden md:flex" : "flex"} min-h-0 flex-1 flex-col overflow-hidden transition-[width] duration-200 md:w-2/5 md:max-w-[360px] md:min-w-[220px] md:flex-none md:shrink-0`
            }
          >
            <div className="flex min-h-0 w-full flex-1 flex-col md:w-[320px]">
              <SearchInput
                icon={<Search size={14} />}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter skills…"
              />

              {filtered.length === 0 ? (
                <EmptyState
                  className="mt-6"
                  icon={query ? <Search size={20} /> : <BookMarked size={20} />}
                  title={query ? `No skills match "${query}".` : "No skills yet. Create or import one."}
                />
              ) : (
                <ul ref={listScrollRef} className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
                  <li style={{ height: listVirtualizer.getTotalSize(), position: "relative" }}>
                  {listVirtualizer.getVirtualItems().map((row) => {
                    const skill = filtered[row.index];
                    const active = selectedId === skill.id || editor?.id === skill.id;
                    return (
                      <div
                        key={skill.id}
                        ref={listVirtualizer.measureElement}
                        data-index={row.index}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${row.start}px)`,
                        }}
                        className="pb-2"
                      >
                        <button
                          type="button"
                          onClick={() => beginEdit(skill)}
                          className={`flex w-full items-center gap-2.5 rounded-xl border p-2.5 text-left transition-colors ${
                            active
                              ? "border-accent/60 bg-bg-elevated shadow-soft"
                              : skill.enabled
                                ? "border-border-subtle bg-canvas hover:bg-bg-hover"
                                : "border-border-subtle/50 bg-canvas/40 opacity-60 hover:bg-bg-hover"
                          }`}
                        >
                          <span className="shrink-0 text-fg-faint">
                            <Sparkles size={14} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium">{skill.name}</span>
                              {skill.builtin && (
                                <span className="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-fg-faint">
                                  Built-in
                                </span>
                              )}
                            </span>
                            {skill.description && (
                              <span className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-fg-dim">
                                {skill.description}
                              </span>
                            )}
                          </span>
                          <span
                            className="shrink-0"
                            onClick={(e) => {
                              e.stopPropagation();
                            }}
                          >
                            <Toggle
                              checked={skill.enabled}
                              onChange={(next) => {
                                upsert({ ...skill, enabled: next });
                              }}
                            />
                          </span>
                        </button>
                      </div>
                    );
                  })}
                  </li>
                </ul>
              )}
            </div>
          </div>

          {/* Right pane: detail editor. On mobile it replaces the list rather
              than splitting the viewport with it. */}
          <div
            className={`${detailOpen ? "flex" : "hidden md:flex"} min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-bg-elevated shadow-soft`}
          >
            {detailOpen && (
              <button
                type="button"
                onClick={closeDetail}
                className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border-subtle px-3 text-xs font-medium text-fg-dim hover:text-fg md:hidden"
              >
                <ChevronLeft size={14} /> All skills
              </button>
            )}
            {!editor && !selected && (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-5 text-center">
                <Wand2 size={28} className="text-fg-faint" />
                <div>
                  <p className="text-sm font-medium">Select a skill to view and edit it</p>
                  <p className="mt-1 text-xs text-fg-dim">
                    Pick one from the list, or create a new skill to see its full content here.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={beginNew}
                  className="mt-1 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover"
                >
                  <Plus size={13} /> New skill
                </button>
              </div>
            )}

            {editor && !editor.id && (
              <div className="min-h-0 flex-1 overflow-y-auto p-5">
                <NewSkillEditor
                  editor={editor}
                  setEditor={setEditor}
                  onSave={saveEditor}
                  onCancel={() => setEditor(null)}
                />
              </div>
            )}

            {selected && (
              <div className="flex h-full min-h-0 flex-1 flex-col">
                <div className="shrink-0 border-b border-border px-2 py-1.5 md:px-4">
                  <Tabs
                    value={detailTab}
                    onChange={(next) => {
                      setDetailTab(next);
                      setListCollapsed(next === "content");
                    }}
                    options={[
                      { value: "overview", label: "Overview" },
                      { value: "content", label: "Content · Files" },
                    ]}
                  />
                </div>
                <div className={`min-h-0 flex-1 ${detailTab === "content" ? "p-2" : "p-4 md:p-5"}`}>
                  {detailTab === "overview" ? (
                    <div className="h-full overflow-y-auto">
                      {editor?.id ? (
                        <SkillDetail
                          skill={selected}
                          editor={editor}
                          setEditor={setEditor}
                          onSave={saveEditor}
                          onDelete={() => removeSkill(selected.id)}
                          onDuplicate={() => duplicate(selected)}
                          onCopy={() => copyInstructions(selected)}
                          saved={saved}
                        />
                      ) : (
                        <SkillDetail
                          skill={selected}
                          editor={{
                            id: selected.id,
                            name: selected.name,
                            description: selected.description,
                            instructions: selected.instructions,
                            enabled: selected.enabled,
                            builtin: selected.builtin,
                          }}
                          setEditor={setEditor}
                          onSave={saveEditor}
                          onDelete={() => removeSkill(selected.id)}
                          onDuplicate={() => duplicate(selected)}
                          onCopy={() => copyInstructions(selected)}
                          saved={saved}
                        />
                      )}
                    </div>
                  ) : (
                    <SkillFiles skill={selected} onSaveSkill={persistSkill} />
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
    </div>
  );
}

function NewSkillEditor({
  editor,
  setEditor,
  onSave,
  onCancel,
}: {
  editor: EditorState;
  setEditor: (e: EditorState) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex h-full flex-col animate-fade-in">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-medium">
          <LayoutGrid size={16} /> New skill
        </h2>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full p-1 text-fg-dim hover:text-fg"
        >
          <X size={16} />
        </button>
      </div>

      <div className="mt-5 space-y-4">
        <Field label="Name">
          <Input
            autoFocus
            value={editor.name}
            onChange={(e) => setEditor({ ...editor, name: e.target.value })}
            placeholder="e.g. Meeting notes"
          />
        </Field>
        <Field label="Description">
          <Input
            value={editor.description}
            onChange={(e) => setEditor({ ...editor, description: e.target.value })}
            placeholder="Short line shown in the skill picker"
          />
        </Field>
        <Field label="Instructions">
          <Textarea
            value={editor.instructions}
            onChange={(e) => setEditor({ ...editor, instructions: e.target.value })}
            rows={10}
            placeholder={`What should ${APP_NAME} do when this skill is called?`}
            className="font-mono text-[13px] leading-6"
          />
        </Field>
      </div>

      <div className="mt-auto flex flex-col gap-3 pt-6 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex items-center gap-2 text-xs text-fg-dim">
          <Toggle
            checked={editor.enabled}
            onChange={(next) => setEditor({ ...editor, enabled: next })}
          />
          Enabled
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-xs text-fg-dim hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={!editor.name.trim() || !editor.instructions.trim()}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-40"
          >
            Create skill
          </button>
        </div>
      </div>
    </div>
  );
}

function SkillDetail({
  skill,
  editor,
  setEditor,
  onSave,
  onDelete,
  onDuplicate,
  onCopy,
  saved,
}: {
  skill: Skill;
  editor: EditorState;
  setEditor: (e: EditorState) => void;
  onSave: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onCopy: () => void;
  saved: boolean;
}) {
  const dirty =
    editor.name !== skill.name ||
    editor.description !== skill.description ||
    editor.instructions !== skill.instructions ||
    editor.enabled !== skill.enabled;

  return (
    <div className="flex h-full flex-col animate-fade-in">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-medium">
          <Sparkles size={16} />
          <span className="truncate">{editor.name || "Untitled skill"}</span>
          {skill.builtin && (
            <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-fg-faint">
              Built-in
            </span>
          )}
        </h2>
        <div className="flex items-center gap-1.5">
          {saved && (
            <span className="flex items-center gap-1 text-xs text-success">
              <Check size={12} /> Saved
            </span>
          )}
          <Tooltip label="Copy instructions">
            <button
              type="button"
              onClick={onCopy}
              className="rounded p-1.5 text-fg-faint hover:bg-bg-hover hover:text-fg"
            >
              <Copy size={14} />
            </button>
          </Tooltip>
          <Tooltip label="Duplicate skill">
            <button
              type="button"
              onClick={onDuplicate}
              className="rounded p-1.5 text-fg-faint hover:bg-bg-hover hover:text-fg"
            >
              <CopyPlus size={14} />
            </button>
          </Tooltip>
          <Tooltip label={skill.builtin ? "Built-in skills can't be deleted" : "Delete skill"}>
            <button
              type="button"
              onClick={onDelete}
              disabled={skill.builtin}
              className="rounded p-1.5 text-fg-faint hover:bg-bg-hover hover:text-error disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-faint"
            >
              <Trash2 size={14} />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="mt-5 space-y-4">
        <Field label="Name">
          <Input
            value={editor.name}
            onChange={(e) => setEditor({ ...editor, name: e.target.value })}
          />
        </Field>
        <Field label="Description">
          <Input
            value={editor.description}
            onChange={(e) => setEditor({ ...editor, description: e.target.value })}
            placeholder="Short line shown in the skill picker"
          />
        </Field>
        <Field label="Instructions">
          <Textarea
            value={editor.instructions}
            onChange={(e) => setEditor({ ...editor, instructions: e.target.value })}
            rows={12}
            className="font-mono text-[13px] leading-6"
          />
        </Field>
      </div>

      <div className="mt-auto flex flex-col gap-3 pt-6 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex items-center gap-2 text-xs text-fg-dim">
          <Toggle
            checked={editor.enabled}
            onChange={(next) => setEditor({ ...editor, enabled: next })}
          />
          Enabled
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setEditor({ ...editor, name: skill.name, description: skill.description, instructions: skill.instructions, enabled: skill.enabled })}
            disabled={!dirty}
            className="rounded-lg px-3 py-1.5 text-xs text-fg-dim hover:text-fg disabled:opacity-40"
          >
            Revert
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={!dirty || !editor.name.trim() || !editor.instructions.trim()}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-40"
          >
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-fg-dim">{label}</label>
      {children}
    </div>
  );
}

