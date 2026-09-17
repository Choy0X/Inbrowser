import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  KEY_ENTER_COMMAND,
  SELECTION_CHANGE_COMMAND,
  type RangeSelection,
} from "lexical";
import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { mergeRegister } from "@lexical/utils";
import {
  ArrowUp,
  ChevronDown,
  FileAudio,
  FileSearch,
  FileText,
  FileType2,
  Film,
  Globe,
  Image as ImageIcon,
  Loader2,
  MoreHorizontal,
  Paperclip,
  ScanLine,
  Search,
  Square,
  Wand2,
  X,
  FileWarning,
} from "lucide-react";
import type { Attachment, AttachmentKind } from "../lib/types";
import type { ModelCapabilities } from "../lib/capabilities";
import type { Skill } from "../lib/skills";
import { newId } from "../lib/store";
import { Tooltip } from "./Tooltip";
import type { GenerationMode } from "./GenerationPanel";
import {
  FILE_KIND_META,
  FILE_KIND_ORDER,
  buildAttachment,
  dataUrlBytes,
  formatBytes,
  kindFromFile,
  supportedKinds,
} from "../lib/attachments";
import { SkillComposerProvider, liveSkillsRegistry } from "./skills/SkillComposerContext";
import { SkillTokenNode } from "./skills/SkillTokenNode";
import { SkillTypeaheadPlugin } from "./skills/SkillTypeaheadPlugin";
import { SkillInfoDialog } from "./skills/SkillInfoDialog";
import { insertSkillToken } from "./skills/insertSkillToken";
import { APP_NAME } from "../lib/appConfig";

const IMAGE_BYTES_LIMIT = 8 * 1024 * 1024; // 8 MiB per media item
const TOTAL_MEDIA_BYTES_LIMIT = 16 * 1024 * 1024; // 16 MiB total

const KIND_ICONS: Record<AttachmentKind, typeof FileText> = {
  image: ImageIcon,
  document: FileType2,
  text: FileText,
  audio: FileAudio,
};

function mediaBytes(attachments: Attachment[]): number {
  let total = 0;
  for (const a of attachments) {
    if (a.dataUrl) total += dataUrlBytes(a.dataUrl);
    for (const page of a.pages ?? []) total += dataUrlBytes(page);
  }
  return total;
}

interface ComposerProps {
  model: string;
  hasModels: boolean;
  caps: ModelCapabilities;
  hasImageCapableModel: boolean;
  hasVideoCapableModel: boolean;
  streaming: boolean;
  skills: Skill[];
  activeSkillNames: string[];
  searchEnabled: boolean;
  searching: boolean;
  onToggleSearch: () => void;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  onOpenModelPicker: () => void;
  onOpenGenerate: (
    mode: GenerationMode,
    opts?: { prompt?: string; image?: { dataUrl: string; name?: string } }
  ) => void;
  onReadDocument: (prompt: string, attachments: Attachment[]) => void;
}

export function Composer(props: ComposerProps) {
  const initialConfig = useMemo<InitialConfigType>(
    () => ({
      namespace: "fachoy-composer",
      nodes: [SkillTokenNode],
      onError: (error: Error) => {
        console.error(error);
      },
      theme: {},
    }),
    []
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <ComposerInner {...props} />
    </LexicalComposer>
  );
}

function ComposerInner({
  model,
  hasModels,
  caps,
  hasImageCapableModel,
  hasVideoCapableModel,
  streaming,
  skills,
  activeSkillNames,
  searchEnabled,
  searching,
  onToggleSearch,
  onSend,
  onStop,
  onOpenModelPicker,
  onOpenGenerate,
  onReadDocument,
}: ComposerProps) {
  const [editor] = useLexicalComposerContext();
  const [plainText, setPlainText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [processing, setProcessing] = useState<Set<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const [dupHintId, setDupHintId] = useState<string | null>(null);
  const [infoSkillId, setInfoSkillId] = useState<string | null>(null);
  const [readingDoc, setReadingDoc] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);
  const pendingKindRef = useRef<AttachmentKind>("text");
  const lastSelectionRef = useRef<RangeSelection | null>(null);
  // Counts nested enter/leave pairs as the pointer crosses child elements —
  // a plain boolean flickers `dragActive` off every time the drag crosses
  // from the container into one of its children.
  const dragDepthRef = useRef(0);

  // Non-React readers (SkillTokenNode.getTextContent, called from inside
  // Lexical's own tree, not React) need the live skills list — mirrored the
  // same way App.tsx mirrors `conversations` into `conversationsRef`.
  liveSkillsRegistry.current = skills;

  useEffect(() => {
    return mergeRegister(
      editor.registerUpdateListener(({ editorState }) => {
        editorState.read(() => {
          setPlainText($getRoot().getTextContent());
        });
      }),
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) lastSelectionRef.current = selection.clone();
          return false;
        },
        COMMAND_PRIORITY_LOW
      )
    );
  }, [editor]);

  const allowedKinds = supportedKinds(caps);

  const updateAttachment = (id: string, next: Attachment) => {
    setAttachments((prev) => prev.map((a) => (a.id === id ? next : a)));
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      const kind = kindFromFile(file);
      const id = newId();
      if (!kind) {
        setAttachments((prev) => [
          ...prev,
          { id, kind: "text", name: file.name, size: file.size, error: "Unsupported file type" },
        ]);
        continue;
      }
      if (!allowedKinds.includes(kind)) {
        setAttachments((prev) => [
          ...prev,
          {
            id,
            kind,
            name: file.name,
            size: file.size,
            error: kind === "image" ? "Images need a vision-capable model" : "Not supported by this model",
          },
        ]);
        continue;
      }
      setAttachments((prev) => [...prev, { id, kind, name: file.name, size: file.size }]);
      setProcessing((prev) => new Set(prev).add(id));
      try {
        const built = await buildAttachment(file);
        if (kind === "image" && built.dataUrl) {
          if (dataUrlBytes(built.dataUrl) > IMAGE_BYTES_LIMIT) {
            built.error = "Image exceeds the 8 MiB limit";
          } else if (mediaBytes([...attachments, built]) > TOTAL_MEDIA_BYTES_LIMIT) {
            built.error = "Combined media exceeds the 16 MiB limit";
          }
        }
        updateAttachment(id, built);
      } catch (err) {
        updateAttachment(id, {
          id,
          kind,
          name: file.name,
          size: file.size,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setProcessing((prev) => {
          const nextSet = new Set(prev);
          nextSet.delete(id);
          return nextSet;
        });
      }
    }
  };

  const triggerPicker = (kind: AttachmentKind) => {
    pendingKindRef.current = kind;
    if (fileInputRef.current) {
      fileInputRef.current.accept = FILE_KIND_META[kind].accept;
      fileInputRef.current.value = "";
      fileInputRef.current.click();
    }
    setMenuOpen(false);
  };

  const hasFilesDrag = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes("Files"));

  const onComposerDragEnter = (e: DragEvent) => {
    if (!hasFilesDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  };

  const onComposerDragOver = (e: DragEvent) => {
    if (!hasFilesDrag(e)) return;
    // Required on dragover (not just drop) or the browser refuses the drop.
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  const onComposerDragLeave = (e: DragEvent) => {
    if (!hasFilesDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  };

  const onComposerDrop = (e: DragEvent) => {
    if (!hasFilesDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    if (streaming) return;
    void handleFiles(e.dataTransfer.files);
  };

  /** Read the contents of document file(s) and send them to the LLM in one go. */
  const handleReadDocument = async (files: FileList | null) => {
    if (!files || files.length === 0 || streaming || searching) return;
    setReadingDoc(true);
    try {
      const built: Attachment[] = [];
      for (const file of Array.from(files)) {
        try {
          const att = await buildAttachment(file);
          if (att.error) {
            built.push({ id: newId(), kind: "text", name: file.name, size: file.size, error: att.error });
          } else {
            built.push(att);
          }
        } catch (err) {
          built.push({
            id: newId(),
            kind: kindFromFile(file) ?? "text",
            name: file.name,
            size: file.size,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const names = built.map((a) => a.name).join(", ");
      onReadDocument(
        `Read the attached document${built.length > 1 ? "s" : ""}${names ? ` (${names})` : ""} and provide a full summary of their contents. Include key facts, figures and any text visible in embedded images.`,
        built.filter((a) => !a.error)
      );
    } finally {
      setReadingDoc(false);
      if (docInputRef.current) docInputRef.current.value = "";
    }
  };

  const canSend =
    hasModels && !streaming && !searching && (plainText.trim().length > 0 || attachments.some((a) => !a.error));

  // CLEAR_EDITOR_COMMAND only does anything when @lexical/react's
  // ClearEditorPlugin is mounted — clearing directly avoids that extra
  // plugin and gives a guaranteed-valid empty state (root always needs at
  // least one child for typing to resume).
  const clearEditor = () => {
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      root.append($createParagraphNode());
      root.selectStart();
    });
  };

  const handleSend = useCallback(() => {
    if (!hasModels || !canSend) return;
    const valid = attachments.filter((a) => !a.error);
    const text = plainText;
    if (!text.trim() && valid.length === 0) return;

    // Slash-command shortcuts for generation and document reading.
    const trimmed = text.trim();
    const slash = trimmed.split(/\s/)[0].toLowerCase();
    if (slash === "/image" || slash === "/video" || slash === "/edit") {
      const mode: GenerationMode = slash === "/video" ? "video" : slash === "/edit" ? "edit" : "image";
      const prompt = trimmed.slice(slash.length).trim();
      const image =
        mode === "edit" && valid.length > 0 ? valid.find((a) => a.kind === "image") ?? valid[0] : undefined;
      onOpenGenerate(mode, {
        prompt,
        image: image?.dataUrl ? { dataUrl: image.dataUrl, name: image.name } : undefined,
      });
      setAttachments([]);
      clearEditor();
      return;
    }
    if (slash === "/read") {
      const prompt = trimmed.slice(slash.length).trim();
      onReadDocument(prompt, valid);
      setAttachments([]);
      clearEditor();
      return;
    }

    onSend(text, valid);
    setAttachments([]);
    clearEditor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachments, canSend, hasModels, onOpenGenerate, onReadDocument, onSend, plainText]);

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (event?.shiftKey) return false; // let the default line-break behavior happen
        event?.preventDefault();
        handleSend();
        return true;
      },
      COMMAND_PRIORITY_LOW
    );
  }, [editor, handleSend]);

  const modelLabel = !hasModels
    ? "No models"
    : model === "auto"
      ? "Auto"
      : model.includes("/")
        ? model.split("/").pop()
        : model;

  const enabledSkills = skills.filter((s) => s.enabled);
  const skillQueryTrimmed = skillQuery.trim().toLowerCase();
  const filteredSkills = skillQueryTrimmed
    ? enabledSkills.filter(
        (s) =>
          s.name.toLowerCase().includes(skillQueryTrimmed) ||
          s.description.toLowerCase().includes(skillQueryTrimmed)
      )
    : enabledSkills;

  const pickSkill = (skill: Skill) => {
    const result = insertSkillToken(editor, skill.id, lastSelectionRef.current);
    if (result === "duplicate") {
      setDupHintId(skill.id);
      window.setTimeout(() => setDupHintId((v) => (v === skill.id ? null : v)), 1500);
      return;
    }
    setSkillsOpen(false);
    setSkillQuery("");
  };

  const infoSkill = skills.find((s) => s.id === infoSkillId) ?? null;

  return (
    <SkillComposerProvider value={{ skills, onOpenInfo: setInfoSkillId }}>
      <div
        data-ui="measure"
        className="relative mx-auto w-full px-4 pb-5 sm:pb-6"
        onDragEnter={onComposerDragEnter}
        onDragOver={onComposerDragOver}
        onDragLeave={onComposerDragLeave}
        onDrop={onComposerDrop}
      >
        {dragActive && (
          <div className="pointer-events-none absolute inset-0 z-20 m-2 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent/10 text-sm font-medium text-accent">
            Drop to attach
          </div>
        )}
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((att) => {
              const Icon = KIND_ICONS[att.kind];
              const isProcessing = processing.has(att.id);
              return (
                <div
                  key={att.id}
                  className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${
                    att.error
                      ? "border-error/40 bg-error/10 text-error"
                      : "border-border-subtle bg-bg-elevated text-fg-dim"
                  }`}
                >
                  {isProcessing ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : att.error ? (
                    <FileWarning size={14} />
                  ) : (
                    <Icon size={14} />
                  )}
                  <span className="max-w-40 truncate">{att.name}</span>
                  <span className="opacity-70">
                    {isProcessing ? "Processing…" : att.error || formatBytes(att.size)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                    className="rounded p-0.5 hover:bg-bg-hover hover:text-fg"
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div data-ui="composer" className="relative border border-border bg-canvas shadow-soft transition-shadow focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
          <PlainTextPlugin
            contentEditable={
              <ContentEditable
                aria-placeholder={`Message ${APP_NAME}`}
                placeholder={
                  <div className="pointer-events-none absolute left-4 top-3.5 select-none text-[15px] text-fg-faint">
                    {`Message ${APP_NAME}`}
                  </div>
                }
                className="max-h-[200px] min-h-[24px] w-full overflow-y-auto bg-transparent px-4 pt-3.5 pb-1.5 text-[15px] leading-6 outline-none"
              />
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin />
          <SkillTypeaheadPlugin skills={skills} />

          <div data-ui="composer-tools" className="relative flex flex-wrap items-center gap-2 px-3 pt-1 pb-2">
              <Tooltip label={searchEnabled ? "Turn off web search" : "Search the web for answers"}>
                <button
                  type="button"
                  onClick={onToggleSearch}
                  disabled={streaming}
                  className={`rounded-md p-2 transition-colors disabled:opacity-40 ${
                    searchEnabled
                      ? "bg-accent text-on-accent hover:bg-accent-hover"
                      : "border border-dashed border-border bg-canvas text-fg-faint hover:bg-bg-hover hover:text-fg"
                  }`}
                >
                  <Globe size={18} />
                </button>
              </Tooltip>
              <Tooltip label={hasImageCapableModel ? "Generate image" : "No image-capable model configured"}>
                <button
                  type="button"
                  onClick={() => onOpenGenerate("image")}
                  disabled={streaming || !hasImageCapableModel}
                  className="hidden rounded-md border border-border bg-canvas p-2 text-fg-dim transition-colors hover:bg-bg-hover hover:text-fg disabled:opacity-40 md:inline-flex"
                >
                  <ImageIcon size={18} />
                </button>
              </Tooltip>
              <Tooltip label={hasImageCapableModel ? "Edit image" : "No image-capable model configured"}>
                <button
                  type="button"
                  onClick={() => onOpenGenerate("edit")}
                  disabled={streaming || !hasImageCapableModel}
                  className="hidden rounded-md border border-border bg-canvas p-2 text-fg-dim transition-colors hover:bg-bg-hover hover:text-fg disabled:opacity-40 md:inline-flex"
                >
                  <ScanLine size={18} />
                </button>
              </Tooltip>
              <Tooltip label={hasVideoCapableModel ? "Generate video" : "No video-capable model configured"}>
                <button
                  type="button"
                  onClick={() => onOpenGenerate("video")}
                  disabled={streaming || !hasVideoCapableModel}
                  className="hidden rounded-md border border-border bg-canvas p-2 text-fg-dim transition-colors hover:bg-bg-hover hover:text-fg disabled:opacity-40 md:inline-flex"
                >
                  <Film size={18} />
                </button>
              </Tooltip>
              <Tooltip label="Read a document">
                <button
                  type="button"
                  onClick={() => docInputRef.current?.click()}
                  disabled={streaming || searching || readingDoc}
                  className="hidden rounded-md border border-border bg-canvas p-2 text-fg-dim transition-colors hover:bg-bg-hover hover:text-fg disabled:opacity-40 md:inline-flex"
                >
                  {readingDoc ? <Loader2 size={18} className="animate-spin" /> : <FileSearch size={18} />}
                </button>
              </Tooltip>
              <input
                ref={docInputRef}
                type="file"
                multiple
                accept={FILE_KIND_META.document.accept}
                className="hidden"
                onChange={(e) => void handleReadDocument(e.target.files)}
              />
              <div className="relative">
                <Tooltip
                  label={
                    activeSkillNames.length > 0
                      ? `Call a skill (active: ${activeSkillNames.join(", ")})`
                      : "Call a skill"
                  }
                >
                  <button
                    type="button"
                    onClick={() => setSkillsOpen((v) => !v)}
                    disabled={streaming}
                    className="rounded-md border border-border bg-canvas p-2 text-fg-dim transition-colors hover:bg-bg-hover hover:text-fg disabled:opacity-40"
                  >
                    <Wand2 size={18} className={skillsOpen ? "text-accent" : ""} />
                  </button>
                </Tooltip>
                {activeSkillNames.length > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent" />
                )}
                {skillsOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-30 bg-overlay/60 md:z-20 md:bg-transparent"
                      onClick={() => {
                        setSkillsOpen(false);
                        setSkillQuery("");
                      }}
                    />
                    <div className="fixed inset-x-0 bottom-0 z-40 max-h-[70vh] overflow-y-auto rounded-t-2xl border-t border-border bg-bg-elevated p-3 shadow-lift animate-fade-in md:absolute md:inset-x-auto md:bottom-11 md:left-0 md:z-30 md:w-80 md:max-h-none md:overflow-visible md:rounded-xl md:border md:p-1.5">
                      <div className="px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-[1.5px] text-fg-faint">
                        Skills
                      </div>
                      {enabledSkills.length > 5 && (
                        <div className="relative px-1 pb-1.5">
                          <Search
                            size={14}
                            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-fg-faint"
                          />
                          <input
                            value={skillQuery}
                            onChange={(e) => setSkillQuery(e.target.value)}
                            placeholder="Search skills…"
                            className="w-full rounded-lg border border-border bg-canvas py-1.5 pl-8 pr-2.5 text-sm outline-none placeholder:text-fg-faint focus:border-accent focus:ring-2 focus:ring-accent/20"
                          />
                        </div>
                      )}
                      {enabledSkills.length === 0 ? (
                        <p className="px-2.5 py-2 text-xs text-fg-faint">
                          No enabled skills. Add or enable them in Settings.
                        </p>
                      ) : filteredSkills.length === 0 ? (
                        <p className="px-2.5 py-2 text-xs text-fg-faint">No skills match your search.</p>
                      ) : (
                        filteredSkills.map((skill) => (
                          <button
                            key={skill.id}
                            type="button"
                            onClick={() => pickSkill(skill)}
                            className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-bg-hover"
                          >
                            <Wand2 size={16} className="mt-0.5 shrink-0 text-accent" />
                            <span className="min-w-0">
                              <span className="block text-sm font-medium">{skill.name}</span>
                              <span className="line-clamp-2 text-xs leading-4 text-fg-faint">
                                {dupHintId === skill.id ? "Already added to this message" : skill.description}
                              </span>
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  </>
                )}
              </div>
              <div>
                <Tooltip label="Attach files">
                  <button
                    type="button"
                    onClick={() => setMenuOpen((v) => !v)}
                    disabled={streaming}
                    className="rounded-md border border-border bg-canvas p-2 text-fg-dim transition-colors hover:bg-bg-hover hover:text-fg disabled:opacity-40"
                  >
                    <Paperclip size={18} />
                  </button>
                </Tooltip>
                {menuOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-30 bg-overlay/60 md:z-20 md:bg-transparent"
                      onClick={() => setMenuOpen(false)}
                    />
                    <div className="fixed inset-x-0 bottom-0 z-40 max-h-[70vh] overflow-y-auto rounded-t-2xl border-t border-border bg-bg-elevated p-3 shadow-lift animate-fade-in md:absolute md:inset-x-auto md:bottom-11 md:left-0 md:z-30 md:w-72 md:max-h-none md:overflow-visible md:rounded-xl md:border md:p-1.5">
                      {FILE_KIND_ORDER.map((kind) => {
                        const Icon = KIND_ICONS[kind];
                        const enabled = allowedKinds.includes(kind);
                        return (
                          <button
                            key={kind}
                            type="button"
                            disabled={!enabled}
                            onClick={() => triggerPicker(kind)}
                            className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left ${
                              enabled ? "hover:bg-bg-hover" : "cursor-not-allowed opacity-40"
                            }`}
                          >
                            <Icon size={16} className="mt-0.5 shrink-0" />
                            <span className="min-w-0">
                              <span className="block text-sm font-medium">{FILE_KIND_META[kind].label}</span>
                              <span className="block text-xs text-fg-faint">{FILE_KIND_META[kind].hint}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => void handleFiles(e.target.files)} />
              <div className="relative md:hidden">
                <Tooltip label="More">
                  <button
                    type="button"
                    onClick={() => setMoreOpen((v) => !v)}
                    disabled={streaming}
                    className="rounded-md border border-border bg-canvas p-2 text-fg-dim transition-colors hover:bg-bg-hover hover:text-fg disabled:opacity-40"
                  >
                    <MoreHorizontal size={18} className={moreOpen ? "text-accent" : ""} />
                  </button>
                </Tooltip>
                {moreOpen && (
                  <>
                    <div className="fixed inset-0 z-30 bg-overlay/60" onClick={() => setMoreOpen(false)} />
                    <div className="fixed inset-x-0 bottom-0 z-40 max-h-[70vh] overflow-y-auto rounded-t-2xl border-t border-border bg-bg-elevated p-3 shadow-lift animate-fade-in">
                      <div className="px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-[1.5px] text-fg-faint">
                        More
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          onOpenGenerate("image");
                          setMoreOpen(false);
                        }}
                        disabled={streaming || !hasImageCapableModel}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <ImageIcon size={16} className="shrink-0 text-accent" />
                        Generate image
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onOpenGenerate("edit");
                          setMoreOpen(false);
                        }}
                        disabled={streaming || !hasImageCapableModel}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <ScanLine size={16} className="shrink-0 text-accent" />
                        Edit image
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onOpenGenerate("video");
                          setMoreOpen(false);
                        }}
                        disabled={streaming || !hasVideoCapableModel}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Film size={16} className="shrink-0 text-accent" />
                        Generate video
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          docInputRef.current?.click();
                          setMoreOpen(false);
                        }}
                        disabled={streaming || searching || readingDoc}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {readingDoc ? (
                          <Loader2 size={16} className="shrink-0 animate-spin text-accent" />
                        ) : (
                          <FileSearch size={16} className="shrink-0 text-accent" />
                        )}
                        Read a document
                      </button>
                    </div>
                  </>
                )}
              </div>
          </div>

          <div className="border-t border-border-subtle" />

          <div data-ui="composer-actions" className="flex items-center justify-between gap-2 px-3 pb-2.5 pt-2">
              <Tooltip label={hasModels ? model : "Add a provider in Settings to pick a model"}>
                <button
                  type="button"
                  onClick={onOpenModelPicker}
                  className="flex max-w-28 items-center gap-1.5 rounded-md bg-night px-3 py-1.5 text-sm text-on-night transition-colors hover:bg-night-elevated md:max-w-52"
                >
                  <span className="truncate">{modelLabel}</span>
                  <ChevronDown size={14} className="shrink-0 text-on-night-soft" />
                </button>
              </Tooltip>

              {streaming ? (
                <Tooltip label="Stop generating">
                  <button
                    type="button"
                    onClick={onStop}
                    className="flex h-9 w-9 items-center justify-center rounded-md bg-night text-on-night transition-colors hover:bg-night-elevated"
                  >
                    <Square size={14} fill="currentColor" />
                  </button>
                </Tooltip>
              ) : (
                <Tooltip label="Send message">
                  <button
                    type="button"
                    onClick={handleSend}
                    disabled={!canSend}
                    className="flex h-9 w-9 items-center justify-center rounded-md bg-accent text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-40 disabled:hover:bg-accent"
                  >
                    <ArrowUp size={18} />
                  </button>
                </Tooltip>
              )}
          </div>
        </div>
        {hasModels ? (
          <p className="mt-2 text-center text-xs text-fg-faint">
            {APP_NAME} may make mistakes. Check important info.
          </p>
        ) : (
          <button
            type="button"
            onClick={onOpenModelPicker}
            className="mt-2 block w-full text-center text-xs text-error hover:underline"
          >
            No model provider configured — add one in Settings before sending a message.
          </button>
        )}
      </div>
      <SkillInfoDialog skill={infoSkill} onClose={() => setInfoSkillId(null)} />
    </SkillComposerProvider>
  );
}
