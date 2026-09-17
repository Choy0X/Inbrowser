import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  Check,
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  FileImage,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  GripVertical,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import type { Skill, SkillResource } from "../lib/skills";
import { isSafeResourcePath, isSafeResourceSegment } from "../lib/skills";
import {
  deleteSkillResource,
  deleteSkillResourcesByPrefix,
  getSkillResources,
  putSkillResource,
  renameSkillResource,
  renameSkillResourcesByPrefix,
} from "../lib/skillstore";
import { ConfirmDialog, InputDialog } from "./Dialog";
import { Tooltip } from "./Tooltip";

const MonacoEditor = lazy(() =>
  Promise.all([
    import("@monaco-editor/react"),
    import("monaco-editor"),
  ]).then(([{ Editor, loader }, monaco]) => {
    loader.config({ monaco });
    return { default: Editor };
  })
);

interface SkillFilesProps {
  skill: Skill;
  /** Persist the updated resources snapshot to localStorage so invocation stays in sync. */
  onSaveSkill: (skill: Skill) => void;
}

const TEXT_LANGUAGES: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", c: "c",
  cpp: "cpp", h: "cpp", hpp: "cpp", cs: "csharp", php: "php", swift: "swift",
  kt: "kotlin", sh: "shell", bash: "shell", zsh: "shell", bat: "bat", ps1: "powershell",
  json: "json", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", cfg: "ini",
  conf: "ini", css: "css", scss: "scss", less: "less", html: "html", htm: "html",
  xml: "xml", md: "markdown", markdown: "markdown", sql: "sql",
};

function extOf(path: string): string {
  return (path.split(".").pop() ?? "").toLowerCase();
}

/** Last path segment, e.g. "scripts/foo.py" -> "foo.py". */
function basenameOf(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Everything before the last path segment, e.g. "scripts/foo.py" -> "scripts". Root files -> "". */
function dirnameOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/**
 * Whether a resource named `name` inside directory `dir` would collide with an
 * existing file or with a folder synthesized from another resource's path.
 * Folders aren't real records, so this is the only place that catches a
 * file/folder name clash - the storage layer alone can't.
 */
function hasCollision(rows: SkillResource[], dir: string, name: string, excludePrefix?: string): boolean {
  const candidate = dir ? `${dir}/${name}` : name;
  return rows.some((r) => {
    if (excludePrefix && (r.path === excludePrefix || r.path.startsWith(`${excludePrefix}/`))) return false;
    return r.path === candidate || r.path.startsWith(`${candidate}/`);
  });
}

/** Classify a resource for display purposes. */
function resourceKind(res: SkillResource): "text" | "image" | "binary" {
  if (res.kind === "image") return "image";
  if (res.kind === "binary") return "binary";
  return "text";
}

const DEFAULT_NAMES = new Set(["skill.md", "readme.md", "readme"]);

/** Hidden marker resource that keeps an otherwise-empty folder visible in the tree. */
const FOLDER_PLACEHOLDER = ".keep";

/** Group a flat resource list into a nested folder tree. */
type TreeDir = { type: "dir"; name: string; path: string; children: TreeNode[] };
type TreeFile = { type: "file"; res: SkillResource };
type TreeNode = TreeDir | TreeFile;

function buildTree(rows: SkillResource[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirs = new Map<string, TreeDir>();
  for (const res of rows) {
    const parts = res.path.split("/").filter(Boolean);
    let level = root;
    let acc = "";
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      let dir = dirs.get(acc);
      if (!dir) {
        dir = { type: "dir", name: parts[i], path: acc, children: [] };
        dirs.set(acc, dir);
        level.push(dir);
      }
      level = dir.children;
    }
    if (parts[parts.length - 1] !== FOLDER_PLACEHOLDER) {
      level.push({ type: "file", res });
    }
  }
  const sortNodes = (nodes: TreeNode[]) =>
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      const an = a.type === "dir" ? a.name : basenameOf(a.res.path);
      const bn = b.type === "dir" ? b.name : basenameOf(b.res.path);
      return an.localeCompare(bn);
    });
  sortNodes(root);
  for (const dir of dirs.values()) sortNodes(dir.children);
  return root;
}

function FileIcon({ res }: { res: SkillResource }) {
  const kind = resourceKind(res);
  const base = basenameOf(res.path).toLowerCase();
  if (kind === "image") return <FileImage size={14} className="shrink-0 text-fg-faint" />;
  const ext = extOf(res.path);
  if (TEXT_LANGUAGES[ext] || DEFAULT_NAMES.has(base)) {
    return <FileCode2 size={14} className="shrink-0 text-fg-faint" />;
  }
  return <FileText size={14} className="shrink-0 text-fg-faint" />;
}

/** Trailing hover-reveal action icons, shared shape for file and folder rows. */
const ROW_ACTIONS_CLASS =
  "flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100";
const DRAG_HANDLE_CLASS = "cursor-grab touch-none rounded p-0.5 text-fg-faint hover:text-fg active:cursor-grabbing";

function FileRow({
  res,
  depth,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  res: SkillResource;
  depth: number;
  active: boolean;
  onSelect: (path: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `file:${res.path}`,
  });

  return (
    <li>
      <div
        ref={setNodeRef}
        style={{
          paddingLeft: 8 + depth * 12,
          transform: CSS.Translate.toString(transform),
          opacity: isDragging ? 0.5 : undefined,
        }}
        className="group flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm hover:bg-bg-hover"
      >
        <button
          type="button"
          onClick={() => onSelect(res.path)}
          className={`flex min-w-0 flex-1 items-center gap-1.5 text-left ${
            active ? "text-accent" : "text-fg-dim"
          }`}
        >
          <FileIcon res={res} />
          <span className="truncate">{basenameOf(res.path)}</span>
        </button>
        <span className={ROW_ACTIONS_CLASS}>
          <Tooltip label="Move">
            <button type="button" aria-label="Move" {...attributes} {...listeners} className={DRAG_HANDLE_CLASS}>
              <GripVertical size={12} />
            </button>
          </Tooltip>
          {resourceKind(res) === "text" && (
            <Tooltip label="Rename">
              <button
                type="button"
                aria-label="Rename"
                onClick={() => onRename(res.path)}
                className="rounded p-0.5 text-fg-faint hover:text-fg"
              >
                <Pencil size={12} />
              </button>
            </Tooltip>
          )}
          <Tooltip label="Delete">
            <button
              type="button"
              aria-label="Delete"
              onClick={() => onDelete(res.path)}
              className="rounded p-0.5 text-fg-faint hover:text-error"
            >
              <Trash2 size={12} />
            </button>
          </Tooltip>
        </span>
      </div>
    </li>
  );
}

function DirRow({
  node,
  depth,
  isOpen,
  onToggle,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
  children,
}: {
  node: TreeDir;
  depth: number;
  isOpen: boolean;
  onToggle: (path: string) => void;
  onNewFile: (path: string) => void;
  onNewFolder: (path: string) => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef: setDragRef, transform, isDragging } = useDraggable({
    id: `dir:${node.path}`,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `drop:${node.path}` });

  const setRefs = (el: HTMLDivElement | null) => {
    setDragRef(el);
    setDropRef(el);
  };

  return (
    <li>
      <div
        ref={setRefs}
        style={{
          paddingLeft: 8 + depth * 12,
          transform: CSS.Translate.toString(transform),
          opacity: isDragging ? 0.5 : undefined,
        }}
        className={`group flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm hover:bg-bg-hover ${
          isOver ? "bg-accent/10 ring-1 ring-inset ring-accent" : ""
        }`}
      >
        <button
          type="button"
          onClick={() => onToggle(node.path)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {isOpen ? (
            <ChevronDown size={13} className="shrink-0 text-fg-faint" />
          ) : (
            <ChevronRight size={13} className="shrink-0 text-fg-faint" />
          )}
          {isOpen ? (
            <FolderOpen size={14} className="shrink-0 text-fg-faint" />
          ) : (
            <Folder size={14} className="shrink-0 text-fg-faint" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        <span className={ROW_ACTIONS_CLASS}>
          <Tooltip label="Move">
            <button type="button" aria-label="Move" {...attributes} {...listeners} className={DRAG_HANDLE_CLASS}>
              <GripVertical size={12} />
            </button>
          </Tooltip>
          <Tooltip label="New file">
            <button
              type="button"
              aria-label="New file"
              onClick={() => onNewFile(node.path)}
              className="rounded p-0.5 text-fg-faint hover:text-fg"
            >
              <FilePlus size={12} />
            </button>
          </Tooltip>
          <Tooltip label="New folder">
            <button
              type="button"
              aria-label="New folder"
              onClick={() => onNewFolder(node.path)}
              className="rounded p-0.5 text-fg-faint hover:text-fg"
            >
              <FolderPlus size={12} />
            </button>
          </Tooltip>
          <Tooltip label="Rename">
            <button
              type="button"
              aria-label="Rename"
              onClick={() => onRename(node.path)}
              className="rounded p-0.5 text-fg-faint hover:text-fg"
            >
              <Pencil size={12} />
            </button>
          </Tooltip>
          <Tooltip label="Delete">
            <button
              type="button"
              aria-label="Delete"
              onClick={() => onDelete(node.path)}
              className="rounded p-0.5 text-fg-faint hover:text-error"
            >
              <Trash2 size={12} />
            </button>
          </Tooltip>
        </span>
      </div>
      {isOpen && <ul>{children}</ul>}
    </li>
  );
}

/**
 * Drop target for moving something back to the top level. Only visible
 * mid-drag, but the node itself stays mounted at all times (hidden via a
 * zero-height collapse, not unmounted) - if it unmounted while not dragging,
 * its droppable ref would only attach to a live DOM node after a drag had
 * already started, too late for dnd-kit to size and register it as a target.
 */
function RootDropZone({ visible }: { visible: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: "drop:__root__" });
  return (
    <div
      ref={setNodeRef}
      className={`overflow-hidden rounded text-center text-[11px] transition-all ${
        visible ? "mb-1 max-h-16 border border-dashed px-2 py-1.5" : "max-h-0 border-0 px-2 py-0"
      } ${isOver ? "border-accent bg-accent/10 text-accent" : "border-border-subtle text-fg-faint"}`}
    >
      Drop here to move to the top level
    </div>
  );
}

export function SkillFiles({ skill, onSaveSkill }: SkillFilesProps) {
  const [rows, setRows] = useState<SkillResource[] | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"view" | "edit">("view");
  const [treeOpen, setTreeOpen] = useState(false);
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [folderDeleteTarget, setFolderDeleteTarget] = useState<string | null>(null);
  const [folderRenameTarget, setFolderRenameTarget] = useState<string | null>(null);
  const [newFileTarget, setNewFileTarget] = useState<string | null>(null);
  const [newFolderTarget, setNewFolderTarget] = useState<string | null>(null);
  const [pendingSelectPath, setPendingSelectPath] = useState<string | null>(null);
  const [confirmAway, setConfirmAway] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
    useSensor(KeyboardSensor)
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resources = await getSkillResources(skill.id);
      setRows(resources);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load files");
    } finally {
      setLoading(false);
    }
  }, [skill.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = useMemo(
    () => rows?.find((r) => r.path === selectedPath) ?? null,
    [rows, selectedPath]
  );

  const syncSnapshot = useCallback(
    (next: SkillResource[]) => {
      onSaveSkill({ ...skill, resources: next });
    },
    [onSaveSkill, skill]
  );

  const flashSaved = () => {
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 1200);
  };

  const applyRows = (next: SkillResource[]) => {
    setRows(next);
    syncSnapshot(next);
  };

  /**
   * Remap local state after a file (isPrefix=false) or a whole folder
   * (isPrefix=true) moved from oldPath to newPath. Shared by manual rename,
   * folder rename, and drag-and-drop so the "update rows/selection/collapse
   * state" logic exists in exactly one place.
   */
  const applyPathMove = (oldPath: string, newPath: string, isPrefix: boolean) => {
    const remap = (p: string) => {
      if (isPrefix) {
        if (p === oldPath || p.startsWith(`${oldPath}/`)) return newPath + p.slice(oldPath.length);
        return p;
      }
      return p === oldPath ? newPath : p;
    };

    const next = (rows ?? []).map((r) => ({ ...r, path: remap(r.path) }));
    if (next.length !== (rows ?? []).length) {
      setError("Move failed: resource count mismatch.");
      return;
    }
    applyRows(next);

    setSelectedPath((prev) => (prev !== null ? remap(prev) : prev));

    setCollapsed((prev) => {
      const nextSet = new Set<string>();
      for (const key of prev) nextSet.add(remap(key));
      return nextSet;
    });
  };

  const handleSaveText = async () => {
    if (!selected || selected.kind === "binary") return;
    const value = textDraft;
    setSaving(true);
    setError(null);
    try {
      const res = await putSkillResource(skill.id, { ...selected, text: value });
      const next = (rows ?? []).map((r) =>
        r.path === selected.path ? { ...r, text: value } : r
      );
      applyRows(next);
      flashSaved();
      void res;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save file");
    } finally {
      setSaving(false);
    }
  };

  // Draft buffer for the currently selected editable file.
  const initialText =
    selected && resourceKind(selected) === "text" ? selected.text ?? "" : "";
  const [textDraft, setTextDraft] = useState(initialText);
  useEffect(() => {
    setTextDraft(initialText);
  }, [selectedPath]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = selected && resourceKind(selected) === "text" && textDraft !== initialText;

  const applyPath = (path: string) => {
    setSelectedPath(path);
    setViewMode("view");
  };

  const handleSelect = (path: string) => {
    if (dirty && path !== selectedPath) {
      setPendingSelectPath(path);
      setConfirmAway(true);
      return;
    }
    applyPath(path);
    setTreeOpen(false);
  };

  const newFileError = (value: string): string | null => {
    const name = value.trim();
    if (!name) return "Name can't be empty.";
    if (!isSafeResourceSegment(name)) return "Name can't contain '/', '\\', or '..'.";
    const dir = newFileTarget ?? "";
    if (hasCollision(rows ?? [], dir, name)) return `A file or folder named "${name}" already exists here.`;
    return null;
  };

  const confirmNewFile = async (value: string) => {
    const dir = newFileTarget ?? "";
    const name = value.trim();
    if (!name) {
      setNewFileTarget(null);
      return;
    }
    const path = dir ? `${dir}/${name}` : name;
    setError(null);
    try {
      await putSkillResource(skill.id, { path, kind: "text", text: "" });
      const next = [...(rows ?? []), { path, kind: "text" as const, text: "" }];
      applyRows(next);
      setSelectedPath(path);
      setViewMode("view");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add file");
    } finally {
      setNewFileTarget(null);
    }
  };

  const newFolderError = (value: string): string | null => {
    const name = value.trim();
    if (!name) return "Name can't be empty.";
    if (!isSafeResourceSegment(name)) return "Name can't contain '/', '\\', or '..'.";
    const dir = newFolderTarget ?? "";
    if (hasCollision(rows ?? [], dir, name)) return `A file or folder named "${name}" already exists here.`;
    return null;
  };

  const confirmNewFolder = async (value: string) => {
    const dir = newFolderTarget ?? "";
    const name = value.trim();
    if (!name) {
      setNewFolderTarget(null);
      return;
    }
    const path = `${dir ? `${dir}/${name}` : name}/${FOLDER_PLACEHOLDER}`;
    setError(null);
    try {
      await putSkillResource(skill.id, { path, kind: "text", text: "" });
      const next = [...(rows ?? []), { path, kind: "text" as const, text: "" }];
      applyRows(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create folder");
    } finally {
      setNewFolderTarget(null);
    }
  };

  const renameError = (value: string): string | null => {
    const name = value.trim();
    if (!name) return "Name can't be empty.";
    if (!isSafeResourceSegment(name)) return "Name can't contain '/', '\\', or '..'.";
    const dir = dirnameOf(renameTarget ?? "");
    const target = dir ? `${dir}/${name}` : name;
    if (target === renameTarget) return null;
    if (hasCollision(rows ?? [], dir, name)) return `A file named "${name}" already exists in this folder.`;
    return null;
  };

  const confirmRename = async (value: string) => {
    const from = renameTarget!;
    const name = value.trim();
    const dir = dirnameOf(from);
    const target = dir ? `${dir}/${name}` : name;
    if (!name || target === from) {
      setRenameTarget(null);
      return;
    }
    setError(null);
    try {
      await renameSkillResource(skill.id, from, target);
      applyPathMove(from, target, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename file");
    } finally {
      setRenameTarget(null);
    }
  };

  const confirmDelete = async () => {
    const path = deleteTarget!;
    setError(null);
    try {
      await deleteSkillResource(skill.id, path);
      const next = (rows ?? []).filter((r) => r.path !== path);
      applyRows(next);
      if (selectedPath === path) setSelectedPath(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete file");
    } finally {
      setDeleteTarget(null);
    }
  };

  const folderRenameError = (value: string): string | null => {
    const name = value.trim();
    if (!name) return "Name can't be empty.";
    if (!isSafeResourceSegment(name)) return "Folder name can't contain '/', '\\', or '..'.";
    const oldPath = folderRenameTarget ?? "";
    const parentDir = dirnameOf(oldPath);
    const target = parentDir ? `${parentDir}/${name}` : name;
    if (target === oldPath) return null;
    if (hasCollision(rows ?? [], parentDir, name, oldPath)) {
      return `A file or folder named "${name}" already exists here.`;
    }
    return null;
  };

  const confirmFolderRename = async (value: string) => {
    const oldPath = folderRenameTarget!;
    const name = value.trim();
    const parentDir = dirnameOf(oldPath);
    const target = parentDir ? `${parentDir}/${name}` : name;
    if (!name || target === oldPath) {
      setFolderRenameTarget(null);
      return;
    }
    setError(null);
    try {
      await renameSkillResourcesByPrefix(skill.id, oldPath, target);
      applyPathMove(oldPath, target, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename folder");
    } finally {
      setFolderRenameTarget(null);
    }
  };

  const confirmFolderDelete = async () => {
    const prefix = folderDeleteTarget!;
    setError(null);
    try {
      await deleteSkillResourcesByPrefix(skill.id, prefix);
      const next = (rows ?? []).filter((r) => r.path !== prefix && !r.path.startsWith(`${prefix}/`));
      applyRows(next);
      if (selectedPath && (selectedPath === prefix || selectedPath.startsWith(`${prefix}/`))) {
        setSelectedPath(null);
      }
      setCollapsed((prev) => {
        const next = new Set<string>();
        for (const key of prev) {
          if (key !== prefix && !key.startsWith(`${prefix}/`)) next.add(key);
        }
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete folder");
    } finally {
      setFolderDeleteTarget(null);
    }
  };

  const confirmSwitch = () => {
    setConfirmAway(false);
    if (pendingSelectPath) {
      applyPath(pendingSelectPath);
      setPendingSelectPath(null);
      setTreeOpen(false);
    }
  };

  const toggleCollapsed = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setDragActive(false);
    const { active, over } = event;
    if (!over) return;

    const activeId = String(active.id);
    const srcKind: "file" | "dir" | null = activeId.startsWith("file:")
      ? "file"
      : activeId.startsWith("dir:")
        ? "dir"
        : null;
    if (!srcKind) return;
    const srcPath = activeId.slice(srcKind === "file" ? 5 : 4);

    const overId = String(over.id);
    if (overId !== "drop:__root__" && !overId.startsWith("drop:")) return;
    const destPath = overId === "drop:__root__" ? "" : overId.replace(/^drop:/, "");

    const destExists =
      destPath === "" || (rows ?? []).some((r) => r.path === destPath || r.path.startsWith(`${destPath}/`));
    if (!destExists) return;

    if (srcKind === "dir" && (destPath === srcPath || destPath.startsWith(`${srcPath}/`))) return;
    if (dirnameOf(srcPath) === destPath) return; // already there

    const name = basenameOf(srcPath);
    const newPath = destPath ? `${destPath}/${name}` : name;

    if (!isSafeResourcePath(newPath)) {
      setError("Invalid destination path.");
      return;
    }

    if (hasCollision(rows ?? [], destPath, name, srcKind === "dir" ? srcPath : undefined)) {
      setError(`"${name}" already exists in that folder.`);
      return;
    }

    setError(null);
    try {
      if (srcKind === "dir") {
        await renameSkillResourcesByPrefix(skill.id, srcPath, newPath);
      } else {
        await renameSkillResource(skill.id, srcPath, newPath);
      }
      applyPathMove(srcPath, newPath, srcKind === "dir");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to move item");
    }
  };

  const tree = useMemo(() => buildTree(rows ?? []), [rows]);

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    if (node.type === "dir") {
      const isOpen = !collapsed.has(node.path);
      return (
        <DirRow
          key={`dir-${node.path}`}
          node={node}
          depth={depth}
          isOpen={isOpen}
          onToggle={toggleCollapsed}
          onNewFile={setNewFileTarget}
          onNewFolder={setNewFolderTarget}
          onRename={setFolderRenameTarget}
          onDelete={setFolderDeleteTarget}
        >
          {node.children.map((c) => renderNode(c, depth + 1))}
        </DirRow>
      );
    }
    const res = node.res;
    return (
      <FileRow
        key={`file-${res.path}`}
        res={res}
        depth={depth}
        active={selectedPath === res.path}
        onSelect={handleSelect}
        onRename={setRenameTarget}
        onDelete={setDeleteTarget}
      />
    );
  };

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-fg-faint">
        <Loader2 size={20} className="animate-spin" />
        <span className="text-xs">Loading files…</span>
      </div>
    );
  }

  if ((rows ?? []).length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <File size={24} className="text-fg-faint" />
        <p className="text-sm text-fg-dim">This skill has no bundled files.</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setNewFileTarget("")}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-hover"
          >
            <FilePlus size={13} /> New file
          </button>
          <button
            type="button"
            onClick={() => setNewFolderTarget("")}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-canvas px-3 py-1.5 text-xs font-medium text-fg-dim hover:bg-bg-hover hover:text-fg"
          >
            <FolderPlus size={13} /> New folder
          </button>
        </div>
        {error && <p className="text-xs text-error">{error}</p>}

        <InputDialog
          open={newFileTarget !== null}
          onClose={() => setNewFileTarget(null)}
          onConfirm={confirmNewFile}
          title="New file"
          label="File name"
          placeholder="file.md"
          validate={newFileError}
          confirmLabel="Create"
        />

        <InputDialog
          open={newFolderTarget !== null}
          onClose={() => setNewFolderTarget(null)}
          onConfirm={confirmNewFolder}
          title="New folder"
          label="Folder name"
          placeholder="folder-name"
          validate={newFolderError}
          confirmLabel="Create"
        />
      </div>
    );
  }

  const explorerPanel = (
    <DndContext
      sensors={sensors}
      onDragStart={() => setDragActive(true)}
      onDragCancel={() => setDragActive(false)}
      onDragEnd={(e) => void handleDragEnd(e)}
    >
      <div className="flex min-h-0 flex-col rounded-lg border border-border-subtle bg-canvas p-1.5">
        <div className="mb-1 flex items-center justify-between px-1.5">
          <span className="text-[11px] uppercase tracking-wide text-fg-faint">Files</span>
          <div className="flex items-center gap-1">
            <Tooltip label="New file">
              <button
                type="button"
                aria-label="New file"
                onClick={() => setNewFileTarget("")}
                className="rounded p-0.5 text-fg-faint hover:text-fg"
              >
                <FilePlus size={13} />
              </button>
            </Tooltip>
            <Tooltip label="New folder">
              <button
                type="button"
                aria-label="New folder"
                onClick={() => setNewFolderTarget("")}
                className="rounded p-0.5 text-fg-faint hover:text-fg"
              >
                <FolderPlus size={13} />
              </button>
            </Tooltip>
            <Tooltip label="Refresh">
              <button
                type="button"
                aria-label="Refresh"
                onClick={() => void refresh()}
                className="rounded p-0.5 text-fg-faint hover:text-fg"
              >
                <RefreshCw size={12} />
              </button>
            </Tooltip>
            <Tooltip label="Close files">
              <button
                type="button"
                aria-label="Close files"
                onClick={() => setTreeOpen(false)}
                className="rounded p-0.5 text-fg-faint hover:text-fg md:hidden"
              >
                <X size={13} />
              </button>
            </Tooltip>
            <Tooltip label="Collapse files panel">
              <button
                type="button"
                aria-label="Collapse files panel"
                onClick={() => setExplorerCollapsed(true)}
                className="hidden rounded p-0.5 text-fg-faint hover:text-fg md:inline-flex"
              >
                <PanelLeftClose size={12} />
              </button>
            </Tooltip>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="px-1">
            <RootDropZone visible={dragActive} />
          </div>
          <ul className="space-y-0.5">{tree.map((n) => renderNode(n, 0))}</ul>
        </div>
      </div>
    </DndContext>
  );

  return (
    <div className="flex h-full flex-col">
      {error && <p className="mb-2 text-xs text-error">{error}</p>}

      {/* Mobile: file-tree drawer toggle */}
      <div className="mb-2 flex shrink-0 items-center gap-2 md:hidden">
        <button
          type="button"
          onClick={() => setTreeOpen((v) => !v)}
          className="flex items-center gap-1.5 rounded-lg border border-border bg-canvas px-2.5 py-1.5 text-xs text-fg-dim hover:bg-bg-hover hover:text-fg"
        >
          <FolderTree size={13} />
          Files
        </button>
        {selected && (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-dim">{selected.path}</span>
        )}
      </div>

      {treeOpen && (
        <div className="fixed inset-0 z-40 flex flex-col md:hidden">
          <div className="absolute inset-0 bg-overlay/60" onClick={() => setTreeOpen(false)} />
          <div className="relative z-10 flex h-[70%] flex-col overflow-hidden rounded-t-2xl border-t border-border bg-bg-elevated p-3 shadow-lift">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium">Files · {skill.name}</span>
              <button
                type="button"
                onClick={() => setTreeOpen(false)}
                className="rounded p-1 text-fg-dim hover:text-fg"
              >
                <X size={16} />
              </button>
            </div>
            {explorerPanel}
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-3">
        {/* File explorer (desktop inline) */}
        <div
          className={`hidden overflow-hidden transition-[width] duration-200 md:flex md:shrink-0 ${
            explorerCollapsed ? "md:w-0" : "md:w-60"
          }`}
        >
          <div className="flex min-h-0 w-60 flex-1 flex-col">{explorerPanel}</div>
        </div>

        {/* Selected-file panel */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border border-border-subtle bg-canvas">
          {explorerCollapsed && (
            <Tooltip label="Show files">
              <button
                type="button"
                onClick={() => setExplorerCollapsed(false)}
                className="absolute left-2 top-2 z-10 hidden rounded-full border border-border bg-bg-elevated p-1.5 text-fg-faint shadow-lift hover:text-fg md:flex"
              >
                <PanelLeftOpen size={14} />
              </button>
            </Tooltip>
          )}
          {!selected ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-fg-faint">
              <File size={22} />
              <span className="text-xs">Select a file to view or edit it</span>
            </div>
          ) : (
            <FileViewer
              res={selected}
              dirty={!!dirty}
              saving={saving}
              savedFlash={savedFlash}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              textDraft={textDraft}
              onTextDraft={setTextDraft}
              onSave={handleSaveText}
            />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        title="Delete file?"
        message={
          <>
            This can&apos;t be undone. Delete <span className="font-mono text-fg">{deleteTarget}</span>{" "}
            from this skill?
          </>
        }
        confirmLabel="Delete"
      />

      <InputDialog
        open={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        onConfirm={confirmRename}
        title="Rename file"
        label="New name"
        initialValue={renameTarget ? basenameOf(renameTarget) : ""}
        placeholder="file.md"
        validate={renameError}
        confirmLabel="Rename"
      />

      <ConfirmDialog
        open={folderDeleteTarget !== null}
        onClose={() => setFolderDeleteTarget(null)}
        onConfirm={confirmFolderDelete}
        title="Delete folder?"
        message={
          <>
            This can&apos;t be undone. Delete{" "}
            <span className="font-mono text-fg">{folderDeleteTarget}</span> and everything inside it?
          </>
        }
        confirmLabel="Delete"
      />

      <InputDialog
        open={folderRenameTarget !== null}
        onClose={() => setFolderRenameTarget(null)}
        onConfirm={confirmFolderRename}
        title="Rename folder"
        label="New name"
        initialValue={folderRenameTarget ? basenameOf(folderRenameTarget) : ""}
        placeholder="folder-name"
        validate={folderRenameError}
        confirmLabel="Rename"
      />

      <InputDialog
        open={newFileTarget !== null}
        onClose={() => setNewFileTarget(null)}
        onConfirm={confirmNewFile}
        title="New file"
        label="File name"
        placeholder="file.md"
        validate={newFileError}
        confirmLabel="Create"
      />

      <InputDialog
        open={newFolderTarget !== null}
        onClose={() => setNewFolderTarget(null)}
        onConfirm={confirmNewFolder}
        title="New folder"
        label="Folder name"
        placeholder="folder-name"
        validate={newFolderError}
        confirmLabel="Create"
      />

      <ConfirmDialog
        open={confirmAway}
        onClose={() => {
          setConfirmAway(false);
          setPendingSelectPath(null);
        }}
        onConfirm={confirmSwitch}
        title="Unsaved changes"
        message="You have unsaved changes in the current file. Discard them and switch?"
        confirmLabel="Discard"
      />
    </div>
  );
}

function FileViewer({
  res,
  dirty,
  saving,
  savedFlash,
  viewMode,
  onViewModeChange,
  textDraft,
  onTextDraft,
  onSave,
}: {
  res: SkillResource;
  dirty: boolean;
  saving: boolean;
  savedFlash: boolean;
  viewMode: "view" | "edit";
  onViewModeChange: (mode: "view" | "edit") => void;
  textDraft: string;
  onTextDraft: (v: string) => void;
  onSave: () => void;
}) {
  const kind = resourceKind(res);
  const language = TEXT_LANGUAGES[extOf(res.path)] ?? "plaintext";
  const isMarkdown = DEFAULT_NAMES.has(basenameOf(res.path).toLowerCase());
  const isTextLike = kind === "text";

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <FileCode2 size={14} className="shrink-0 text-fg-faint" />
          <span className="truncate font-mono text-xs text-fg-dim">{res.path}</span>
          {dirty && (
            <span className="shrink-0 rounded-full bg-amber/15 px-2 py-0.5 text-[10px] text-amber">
              Unsaved
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {savedFlash && (
            <span className="flex items-center gap-1 text-xs text-success">
              <Check size={12} /> Saved
            </span>
          )}
          {isTextLike && (
            <div className="flex items-center overflow-hidden rounded-lg border border-border">
              <button
                type="button"
                onClick={() => onViewModeChange("view")}
                className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                  viewMode === "view"
                    ? "bg-accent/15 text-accent"
                    : "text-fg-dim hover:bg-bg-hover hover:text-fg"
                }`}
              >
                View
              </button>
              <button
                type="button"
                onClick={() => onViewModeChange("edit")}
                className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                  viewMode === "edit"
                    ? "bg-accent/15 text-accent"
                    : "text-fg-dim hover:bg-bg-hover hover:text-fg"
                }`}
              >
                Edit
              </button>
            </div>
          )}
        </div>
      </div>

      {kind === "image" ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto p-4">
          <img
            src={res.dataUrl}
            alt={res.path}
            className="max-h-full max-w-full rounded-lg border border-border-subtle object-contain"
          />
          {res.dataUrl && (
            <a
              href={res.dataUrl}
              download={basenameOf(res.path)}
              className="text-xs text-accent hover:underline"
            >
              Download
            </a>
          )}
        </div>
      ) : kind === "binary" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
          <File size={24} className="text-fg-faint" />
          <p className="max-w-xs text-xs text-fg-dim">
            This is a binary file and can&apos;t be edited as text.
          </p>
          {res.dataUrl && (
            <a
              href={res.dataUrl}
              download={basenameOf(res.path)}
              className="rounded-lg border border-border bg-canvas px-3 py-1.5 text-xs text-fg-dim hover:bg-bg-hover"
            >
              Download file
            </a>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center gap-2 text-fg-faint">
                  <Loader2 size={16} className="animate-spin" /> Loading editor…
                </div>
              }
            >
              <MonacoEditor
                height="100%"
                language={isMarkdown ? "markdown" : language}
                value={textDraft}
                onChange={(v) => onTextDraft(v ?? "")}
                theme="vs-dark"
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  fontFamily: "'Cascadia Code', 'Fira Code', Consolas, Menlo, monospace",
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                  automaticLayout: true,
                  readOnly: viewMode === "view",
                  padding: { top: 8, bottom: 8 },
                }}
              />
            </Suspense>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-3 py-2">
            {viewMode === "edit" && (
              <button
                type="button"
                onClick={onSave}
                disabled={!dirty || saving}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-40"
              >
                {saving ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Save size={12} />
                )}
                Save
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
