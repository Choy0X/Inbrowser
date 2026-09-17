import { useEffect, useMemo, useRef, useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import {
  Check,
  Copy,
  Download,
  Eye,
  FileCode2,
  Pencil,
  Play,
  Puzzle,
  Square,
  Undo2,
} from "lucide-react";
import { downloadText } from "../lib/artifactDownload";
import { inlineCodeFilename, inlineCodeLanguage } from "../lib/inlineCodeFile";
import { getPluginState, usePluginStates } from "../lib/pluginStore";
import { getPluginForLanguage } from "../lib/plugins/registry";
import type { CodeRunner } from "../lib/codeRunners/types";
import { CodeEditor } from "./CodeEditor";
import { CodeRunOutput, type RunLine, type RunStatus } from "./CodeRunOutput";
import { Tooltip } from "./Tooltip";

/**
 * A fenced code block in chat prose, rendered as a small file rather than as
 * static highlighted text: copy, download, edit in Monaco, and run it on the
 * in-browser runtime for its language.
 *
 * This is the same set of affordances ArtifactPanel offers, at the scale of a
 * snippet and without leaving the message. Blocks large enough to cross
 * fencedCodeArtifacts.ts's PROMOTE_THRESHOLD still become real artifacts and
 * open the side panel instead - this only covers everything below that line,
 * which previously had a Copy button and nothing else.
 *
 * Mounted only for completed messages (see Markdown.tsx): while a message is
 * still streaming the plain highlighter renders, so nothing here re-runs per
 * token and there is no draft or run output to lose mid-stream.
 */

const HTML_LANGS = new Set(["html", "htm"]);
const SVG_LANGS = new Set(["svg"]);

/** Monaco has no bounded flex parent here, so it gets an explicit height: the
 *  code's own height, capped so one long snippet can't fill the viewport. */
const LINE_HEIGHT = 19;
const MIN_EDITOR_PX = 120;
const MAX_EDITOR_PX = 480;

function editorHeight(code: string): number {
  const lines = code.split("\n").length;
  return Math.min(Math.max(lines * LINE_HEIGHT + 16, MIN_EDITOR_PX), MAX_EDITOR_PX);
}

function markupKind(language: string): "html" | "svg" | null {
  if (HTML_LANGS.has(language)) return "html";
  if (SVG_LANGS.has(language)) return "svg";
  return null;
}

function iframeSrcDoc(kind: "html" | "svg", value: string): string {
  if (kind === "svg") return `<!DOCTYPE html><html><body style="margin:0">${value}</body></html>`;
  return value;
}

function ToolbarButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] transition-colors hover:bg-night-elevated hover:text-on-night ${
          active ? "bg-night-elevated text-on-night" : "text-on-night-soft"
        }`}
      >
        {children}
      </button>
    </Tooltip>
  );
}

export function InlineCodeFile({
  code,
  language,
  index,
  editKey,
  editedCode,
  onEdit,
  onOpenPlugins,
}: {
  /** The code exactly as the model wrote it. */
  code: string;
  /** The fence's language tag, if it had one. */
  language?: string;
  /** 1-based position among this message's code blocks, used for the filename. */
  index: number;
  /** Identity of this block's stored edit - see lib/inlineCodeFile.ts. */
  editKey: string;
  /** The user's saved edit for this block, if any. */
  editedCode?: string;
  /** Persists an edit onto the message; `null` clears it. Omitted in contexts
   *  with no message to write to, where edits stay local to this component. */
  onEdit?: (key: string, content: string | null) => void;
  onOpenPlugins?: () => void;
}) {
  const lang = inlineCodeLanguage(language);
  const filename = useMemo(() => inlineCodeFilename(language, code, index), [language, code, index]);
  const kind = markupKind(lang);

  // `draft` holds keystrokes that haven't been flushed to the message yet; it
  // is the live value while editing, so Monaco is never handed back its own
  // debounced echo.
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? editedCode ?? code;
  const edited = value !== code;

  const [mode, setMode] = useState<"code" | "edit" | "preview">("code");
  const [copied, setCopied] = useState(false);

  const pluginStates = usePluginStates();
  const plugin = getPluginForLanguage(lang);
  const pluginState = plugin ? getPluginState(pluginStates, plugin.id) : null;
  const canRun = !!plugin && !!pluginState?.enabled && (plugin.builtin || pluginState.installed);

  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [runLines, setRunLines] = useState<RunLine[]>([]);
  const [hasRunOnce, setHasRunOnce] = useState(false);
  const [inputPrompt, setInputPrompt] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pendingInputResolveRef = useRef<((value: string | null) => void) | null>(null);
  // Created on first Run, not at mount: a transcript can hold dozens of these,
  // and nothing should allocate a runtime for a block nobody runs.
  const runnerRef = useRef<CodeRunner | null>(null);

  const running = runStatus === "loading" || runStatus === "running";

  const flushRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (flushRef.current !== null) window.clearTimeout(flushRef.current);
      abortRef.current?.abort();
      runnerRef.current?.dispose();
    },
    []
  );

  const resolvePendingInput = (next: string | null) => {
    pendingInputResolveRef.current?.(next);
    pendingInputResolveRef.current = null;
    setInputPrompt(null);
  };

  const handleChange = (next: string) => {
    setDraft(next);
    if (!onEdit) return;
    // Debounced: every keystroke would otherwise rewrite the conversation
    // record in IndexedDB.
    if (flushRef.current !== null) window.clearTimeout(flushRef.current);
    flushRef.current = window.setTimeout(() => {
      flushRef.current = null;
      onEdit(editKey, next);
    }, 500);
  };

  const handleRevert = () => {
    if (flushRef.current !== null) window.clearTimeout(flushRef.current);
    setDraft(null);
    onEdit?.(editKey, null);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* Clipboard API unavailable (e.g. insecure context) — nothing to fall back to. */
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    // workerRunner unblocks the worker itself on abort, but this component's
    // own onInputRequest promise needs resolving too, or the prompt stays open
    // after the run has already stopped.
    resolvePendingInput(null);
  };

  const handleRun = () => {
    if (!plugin) return;
    if (!runnerRef.current) runnerRef.current = plugin.createRunner();
    const controller = new AbortController();
    abortRef.current = controller;
    setHasRunOnce(true);
    setRunLines([]);
    setRunStatus("loading");
    void runnerRef.current
      .run(value, {
        onReady: () => setRunStatus("running"),
        onStdout: (line) => setRunLines((l) => [...l, { stream: "stdout", text: line }]),
        onStderr: (line) => setRunLines((l) => [...l, { stream: "stderr", text: line }]),
        onStatus: (line) => setRunLines((l) => [...l, { stream: "status", text: line }]),
        onInputRequest: (prompt) =>
          new Promise<string | null>((resolve) => {
            pendingInputResolveRef.current = resolve;
            setInputPrompt(prompt);
          }),
        signal: controller.signal,
      })
      .then((outcome) => {
        if (outcome.kind === "error") {
          setRunLines((l) => [...l, { stream: "stderr", text: outcome.message }]);
        }
        setRunStatus(
          outcome.kind === "success" ? "success" : outcome.kind === "aborted" ? "aborted" : "error"
        );
      });
  };

  return (
    <div data-ui="code-file" className="my-3 overflow-hidden rounded-lg bg-code-bg">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-on-night-soft/15 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <FileCode2 size={13} className="shrink-0 text-on-night-soft" />
          <span className="truncate font-mono text-[11px] text-on-night">{filename}</span>
          <span data-ui="meta" className="shrink-0 text-[11px] text-on-night-soft">
            {lang}
          </span>
          {edited && (
            <span className="shrink-0 rounded-md bg-amber/15 px-1.5 py-0.5 text-[10px] text-amber">
              Edited
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {plugin &&
            (canRun ? (
              <ToolbarButton label={running ? "Stop" : "Run"} onClick={running ? handleStop : handleRun}>
                {running ? <Square size={11} /> : <Play size={12} />}
                {running ? "Stop" : "Run"}
              </ToolbarButton>
            ) : (
              onOpenPlugins && (
                <ToolbarButton
                  label={`Install the ${plugin.name} runtime to run this in your browser`}
                  onClick={onOpenPlugins}
                >
                  <Puzzle size={12} />
                  Install {plugin.name}
                </ToolbarButton>
              )
            ))}

          {kind && (
            <ToolbarButton
              label={mode === "preview" ? "Show source" : "Preview"}
              active={mode === "preview"}
              onClick={() => setMode((m) => (m === "preview" ? "code" : "preview"))}
            >
              <Eye size={12} />
              Preview
            </ToolbarButton>
          )}

          <ToolbarButton
            label={mode === "edit" ? "Done editing" : "Edit"}
            active={mode === "edit"}
            onClick={() => setMode((m) => (m === "edit" ? "code" : "edit"))}
          >
            {mode === "edit" ? <Check size={12} /> : <Pencil size={12} />}
            {mode === "edit" ? "Done" : "Edit"}
          </ToolbarButton>

          {edited && (
            <ToolbarButton label="Revert to the original" onClick={handleRevert}>
              <Undo2 size={12} />
            </ToolbarButton>
          )}

          <ToolbarButton label={`Download ${filename}`} onClick={() => downloadText(filename, value)}>
            <Download size={12} />
          </ToolbarButton>

          <ToolbarButton label="Copy" onClick={() => void handleCopy()}>
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? "Copied" : "Copy"}
          </ToolbarButton>
        </div>
      </div>

      {mode === "edit" ? (
        <div style={{ height: editorHeight(value) }}>
          <CodeEditor
            language={lang}
            value={value}
            readOnly={false}
            onChange={handleChange}
            height={editorHeight(value)}
          />
        </div>
      ) : mode === "preview" && kind ? (
        <iframe
          sandbox="allow-scripts"
          srcDoc={iframeSrcDoc(kind, value)}
          title={filename}
          className="w-full border-0 bg-white"
          style={{ height: editorHeight(value) }}
        />
      ) : (
        // The overflow lived on `pre.code-block` before; this block replaces
        // that wrapper, so it has to carry the horizontal scroll itself or long
        // lines are clipped by the card's own overflow-hidden.
        <div className="overflow-x-auto">
          <SyntaxHighlighter
            language={lang}
            style={oneDark}
            PreTag="div"
            customStyle={{ margin: 0, background: "transparent" }}
          >
            {value}
          </SyntaxHighlighter>
        </div>
      )}

      {hasRunOnce && (
        <CodeRunOutput
          status={runStatus ?? "loading"}
          lines={runLines}
          onStop={handleStop}
          inputPrompt={inputPrompt}
          onSubmitInput={(next) => resolvePendingInput(next)}
          onCancelInput={() => resolvePendingInput(null)}
        />
      )}
    </div>
  );
}
