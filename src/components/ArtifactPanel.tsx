import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CircleX,
  Code2,
  Cpu,
  Download,
  FileCode2,
  FileText,
  Loader2,
  Lock,
  Play,
  Puzzle,
  Save,
  Square,
  X,
} from "lucide-react";
import type { GeneratedArtifact } from "../lib/types";
import { downloadBlob, downloadFilename, downloadText } from "../lib/artifactDownload";
import { getPluginState, usePluginStates } from "../lib/pluginStore";
import { getPluginForLanguage } from "../lib/plugins/registry";
import { CodeEditor } from "./CodeEditor";
import { CodeRunOutput, type RunLine, type RunStatus } from "./CodeRunOutput";
import { Markdown } from "./Markdown";
import { Tooltip } from "./Tooltip";
import { Tabs } from "./ui";

function artifactIcon(type: GeneratedArtifact["type"]) {
  if (type === "code") return FileCode2;
  if (type === "html" || type === "svg") return Code2;
  return FileText;
}

/** Wraps SVG markup in a minimal HTML shell before handing it to the sandboxed preview iframe. */
function iframeSrcDoc(kind: "html" | "svg", value: string): string {
  if (kind === "svg") {
    return `<!DOCTYPE html><html><body style="margin:0">${value}</body></html>`;
  }
  return value;
}

const HTML_LANGS = new Set(["html", "htm"]);
const SVG_LANGS = new Set(["svg"]);

/**
 * Some models (especially weaker/free ones — see fencedCodeArtifacts.ts's
 * doc comment) label a full HTML/SVG document as type="code"
 * language="html" instead of the dedicated type="html"/"svg" the system
 * prompt asks for. Rendering that literally would mean "Preview" just shows
 * the same read-only code editor as "Edit" — no live preview at all. Treat
 * a code artifact whose language says html/svg the same as a real
 * type="html"/"svg" one for preview purposes, regardless of which shape the
 * model actually emitted.
 */
function renderableMarkupKind(artifact: GeneratedArtifact): "html" | "svg" | null {
  if (artifact.type === "html") return "html";
  if (artifact.type === "svg") return "svg";
  if (artifact.type === "code" && artifact.language) {
    const lang = artifact.language.toLowerCase();
    if (HTML_LANGS.has(lang)) return "html";
    if (SVG_LANGS.has(lang)) return "svg";
  }
  return null;
}

function docFilename(artifact: GeneratedArtifact, ext: "docx" | "pdf"): string {
  const base = artifact.title.replace(/\.[^./\\]+$/, "");
  return `${base || "document"}.${ext}`;
}

export function ArtifactPanel({
  artifact,
  resolvedModel,
  provider,
  onClose,
  onChange,
  onOpenPlugins,
}: {
  artifact: GeneratedArtifact;
  resolvedModel?: string;
  provider?: string;
  onClose: () => void;
  onChange: (content: string) => void;
  onOpenPlugins: () => void;
}) {
  const [viewMode, setViewMode] = useState<"preview" | "edit">("preview");
  const [draft, setDraft] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [throttledValue, setThrottledValue] = useState(artifact.editedContent ?? artifact.content);
  const [seenArtifactId, setSeenArtifactId] = useState(artifact.id);
  const lastThrottleRef = useRef(0);

  // Re-read on focus: installing a runtime happens on another page, and this
  // used to be read once at mount, so the Run button stayed dead until the
  // panel remounted. The listeners now live in usePluginStates, shared with
  // every inline code block in the transcript.
  const pluginStates = usePluginStates();
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [runLines, setRunLines] = useState<RunLine[]>([]);
  const [hasRunOnce, setHasRunOnce] = useState(false);
  // PHP's run output is real HTML (php-wasm's runStream() models an HTTP
  // response) - rather than log it as text like every other language, the
  // editor area itself becomes the rendered preview once a run succeeds (see
  // the isPhp render branch below). Accumulated by joining each posted
  // stdout line back with "\n", undoing phpWorker.ts's own split("\n").
  const [phpHtml, setPhpHtml] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // The program called input(prompt) and is blocked waiting for a line of
  // text - only possible here (the manually-clicked Run button), never for
  // the model's run_code tool call. Requires SharedArrayBuffer (cross-origin
  // isolation); workerRunner.ts falls back to the existing immediate-EOF
  // behavior when that isn't available, so this UI simply never appears then.
  // null = not awaiting; a string (possibly "") = awaiting, with input()'s
  // own prompt text to show instead of a generic placeholder.
  const [inputPrompt, setInputPrompt] = useState<string | null>(null);
  const pendingInputResolveRef = useRef<((value: string | null) => void) | null>(null);

  const resolvePendingInput = (value: string | null) => {
    pendingInputResolveRef.current?.(value);
    pendingInputResolveRef.current = null;
    setInputPrompt(null);
  };

  const handleInputRequest = (prompt: string) =>
    new Promise<string | null>((resolve) => {
      pendingInputResolveRef.current = resolve;
      setInputPrompt(prompt);
    });

  const plugin = artifact.type === "code" ? getPluginForLanguage(artifact.language) : undefined;
  const pluginState = plugin ? getPluginState(pluginStates, plugin.id) : null;
  const canRun = !!plugin && !!pluginState?.enabled && (plugin.builtin || pluginState.installed);
  const running = runStatus === "loading" || runStatus === "running";
  // PHP's run output should be rendered as HTML, not logged as text - see the
  // dedicated render branch below and the phpHtml state above.
  const isPhp = plugin?.id === "php";

  // Keyed on artifact identity (not just plugin identity) so switching to a
  // different code artifact of the same language starts a fresh runner/worker
  // rather than reusing warm state from the previously open one.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const runner = useMemo(() => (plugin ? plugin.createRunner() : null), [artifact.id, artifact.language]);
  useEffect(() => () => runner?.dispose(), [runner]);

  // Reset local editing state whenever a different artifact is opened. Done
  // synchronously during render (React's documented "adjusting state when a
  // prop changes" pattern) rather than in a useEffect: an effect runs AFTER
  // the DOM commits, so a freshly-mounted html/svg iframe would briefly get
  // srcDoc set to the PREVIOUS artifact's content, then reassigned a moment
  // later — reassigning srcDoc on a just-created iframe before its first
  // navigation settles can silently fail to render at all. Correcting the
  // state before this render commits means the iframe is only ever created
  // with the right content in the first place.
  if (artifact.id !== seenArtifactId) {
    setSeenArtifactId(artifact.id);
    setViewMode("preview");
    setDraft(null);
    setSavedFlash(false);
    setThrottledValue(artifact.editedContent ?? artifact.content);
    lastThrottleRef.current = 0;
    abortRef.current?.abort();
    resolvePendingInput(null);
    setRunStatus(null);
    setRunLines([]);
    setHasRunOnce(false);
    setPhpHtml(null);
  }

  // An artifact still being written is read-only: an edit made mid-stream
  // becomes a draft, and a draft takes precedence over the incoming content,
  // so the rest of the generation would be silently discarded from view.
  const streaming = artifact.status === "streaming";
  const sourceValue = artifact.editedContent ?? artifact.content;
  const value = draft ?? sourceValue;
  const dirty = draft !== null && draft !== sourceValue;
  // While the file is still being written there is nothing to switch between
  // and nothing to save, so the Preview/Edit control is not rendered at all and
  // the panel is pinned to the read-only preview. `viewMode` is left untouched
  // so a re-generation of an already-open artifact returns to whichever mode
  // the user had chosen once it finishes.
  const activeView = streaming ? "preview" : viewMode;
  const Icon = artifactIcon(artifact.type);
  const markupKind = renderableMarkupKind(artifact);

  // The HTML/SVG live preview reloads its whole iframe document on every
  // update, so during active streaming it's throttled to avoid flicker/thrash
  // — at most once per ~200ms, syncing immediately once streaming ends.
  useEffect(() => {
    if (!streaming) {
      setThrottledValue(sourceValue);
      return;
    }
    const elapsed = Date.now() - lastThrottleRef.current;
    if (elapsed >= 200) {
      lastThrottleRef.current = Date.now();
      setThrottledValue(sourceValue);
      return;
    }
    const t = window.setTimeout(() => {
      lastThrottleRef.current = Date.now();
      setThrottledValue(sourceValue);
    }, 200 - elapsed);
    return () => window.clearTimeout(t);
  }, [sourceValue, streaming]);

  const handleSave = () => {
    if (draft === null) return;
    onChange(draft);
    setDraft(null);
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 1500);
  };

  const handleDownload = () => downloadText(downloadFilename(artifact), sourceValue);

  const handleRun = () => {
    if (!runner) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setHasRunOnce(true);
    setRunLines([]);
    setRunStatus("loading");
    setPhpHtml(isPhp ? "" : null);
    // Running from the Edit tab would otherwise finish invisibly behind the
    // source editor - switch to Preview so the rendered result is the thing
    // the user actually sees land.
    if (isPhp) setViewMode("preview");
    void runner
      .run(sourceValue, {
        onReady: () => setRunStatus("running"),
        onStdout: (line) => {
          setRunLines((l) => [...l, { stream: "stdout", text: line }]);
          if (isPhp) setPhpHtml((h) => (h ? `${h}\n${line}` : line));
        },
        onStderr: (line) => setRunLines((l) => [...l, { stream: "stderr", text: line }]),
        onStatus: (line) => setRunLines((l) => [...l, { stream: "status", text: line }]),
        onInputRequest: handleInputRequest,
        signal: controller.signal,
      })
      .then((outcome) => {
        if (outcome.kind === "error") {
          setRunLines((l) => [...l, { stream: "stderr", text: outcome.message }]);
        }
        setRunStatus(outcome.kind === "success" ? "success" : outcome.kind === "aborted" ? "aborted" : "error");
      });
  };

  const handleStop = () => {
    abortRef.current?.abort();
    // workerRunner.ts unblocks the worker itself on abort, but this promise
    // (this component's own onInputRequest call) needs resolving too so the
    // prompt UI doesn't stay stuck open after the run has already stopped.
    resolvePendingInput(null);
  };

  const [exporting, setExporting] = useState<"docx" | "pdf" | null>(null);

  const handleExportDoc = async (kind: "docx" | "pdf") => {
    setExporting(kind);
    try {
      const [{ parseMarkdownToBlocks }, exporter] = await Promise.all([
        import("../lib/docModel"),
        kind === "docx" ? import("../lib/exportDocx") : import("../lib/exportPdf"),
      ]);
      const blocks = parseMarkdownToBlocks(sourceValue);
      const blob =
        kind === "docx"
          ? await (exporter as typeof import("../lib/exportDocx")).exportDocx(blocks)
          : await (exporter as typeof import("../lib/exportPdf")).exportPdf(blocks);
      downloadBlob(docFilename(artifact, kind), blob);
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Icon size={15} className="shrink-0 text-fg-faint" />
          <span className="truncate text-sm font-medium">{artifact.title}</span>
          {streaming && (
            <span className="flex shrink-0 items-center gap-1 rounded-md bg-accent/15 px-2 py-0.5 text-[10px] text-accent">
              <Loader2 size={10} className="animate-spin" /> Writing…
            </span>
          )}
          {artifact.status === "truncated" && (
            <span className="shrink-0 rounded-md bg-amber/15 px-2 py-0.5 text-[10px] text-amber">
              Incomplete
            </span>
          )}
          {dirty && (
            <span className="shrink-0 rounded-md bg-amber/15 px-2 py-0.5 text-[10px] text-amber">
              Unsaved
            </span>
          )}
          {resolvedModel && (
            <span className="flex min-w-0 shrink items-center gap-1 rounded-md bg-night px-2 py-0.5 text-[10px] text-on-night">
              <Cpu size={10} className="shrink-0 text-accent" />
              <span className="truncate">
                {resolvedModel}
                {provider && provider !== resolvedModel ? ` (${provider})` : ""}
              </span>
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {savedFlash && (
            <span className="flex items-center gap-1 text-xs text-success">
              <Check size={12} /> Saved
            </span>
          )}
          {streaming ? (
            <span className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-fg-faint">
              <Lock size={11} />
              Read-only
            </span>
          ) : (
            <Tabs
              value={activeView}
              onChange={setViewMode}
              options={[
                { value: "preview", label: "Preview" },
                { value: "edit", label: "Edit" },
              ]}
            />
          )}
          <Tooltip label="Close">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-fg-dim hover:bg-bg-hover hover:text-fg"
            >
              <X size={16} />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {markupKind ? (
          activeView === "preview" ? (
            // Keyed on content length while streaming, not just artifact.id:
            // reassigning `srcDoc` on the SAME iframe element while a prior
            // navigation hasn't settled is a known Chromium quirk where the
            // update can be silently coalesced/dropped, leaving the DOM
            // stuck on stale content even though this prop is current
            // (closing/reopening the panel "fixed" it before only because
            // that remounts a fresh iframe). Forcing a fresh element on each
            // throttled update sidesteps the race entirely — a brief flicker
            // per update while streaming, but never stuck/frozen. Reverts to
            // the stable per-artifact key once streaming ends.
            <iframe
              key={streaming ? `${artifact.id}:${throttledValue.length}` : artifact.id}
              sandbox="allow-scripts"
              srcDoc={iframeSrcDoc(markupKind, throttledValue)}
              title={artifact.title}
              className="h-full w-full border-0 bg-white"
            />
          ) : (
            <CodeEditor
              language={markupKind === "html" ? "html" : "xml"}
              value={value}
              readOnly={streaming}
              onChange={setDraft}
            />
          )
        ) : artifact.type === "code" && isPhp ? (
          // PHP's output is real HTML (php-wasm's runStream() models an HTTP
          // response) - the editor area itself becomes the rendered preview
          // once a run succeeds, matching the html/svg markupKind branch
          // above, instead of logging it as text below a still-visible editor.
          activeView === "edit" ? (
            <CodeEditor language="php" value={value} readOnly={false} onChange={setDraft} />
          ) : runStatus === "success" && phpHtml !== null ? (
            <iframe
              key={artifact.id}
              sandbox="allow-scripts"
              srcDoc={phpHtml}
              title={artifact.title}
              className="h-full w-full border-0 bg-white"
            />
          ) : runStatus === "loading" || runStatus === "running" ? (
            <div className="flex h-full items-center justify-center gap-2 text-fg-faint">
              <Loader2 size={16} className="animate-spin" /> Running PHP…
            </div>
          ) : runStatus === "error" || runStatus === "aborted" ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-fg-faint">
              {runStatus === "error" ? <CircleX size={20} className="text-error" /> : <Square size={16} />}
              <span>{runStatus === "error" ? (runLines.at(-1)?.text ?? "Run failed.") : "Stopped."}</span>
            </div>
          ) : (
            <CodeEditor language="php" value={value} readOnly onChange={setDraft} />
          )
        ) : artifact.type === "code" ? (
          <div className="flex h-full flex-col">
            <div className="min-h-0 flex-1">
              <CodeEditor
                language={artifact.language ?? "plaintext"}
                value={value}
                readOnly={activeView === "preview"}
                onChange={setDraft}
              />
            </div>
            {hasRunOnce && (
              <CodeRunOutput
                status={runStatus ?? "loading"}
                lines={runLines}
                onStop={handleStop}
                inputPrompt={inputPrompt}
                onSubmitInput={(value) => resolvePendingInput(value)}
                onCancelInput={() => resolvePendingInput(null)}
              />
            )}
          </div>
        ) : activeView === "preview" ? (
          artifact.type === "document" ? (
            <div className="h-full overflow-auto bg-bg-subtle p-[4cqw]" style={{ containerType: "inline-size" }}>
              <div className="markdown-paper doc-page mx-auto max-w-[8.5in] rounded-sm bg-white px-[clamp(1.25rem,7cqw,4rem)] py-[clamp(1.5rem,9cqw,5rem)] text-black shadow-lift">
                <Markdown text={value} />
              </div>
            </div>
          ) : (
            <div className="h-full overflow-auto p-4">
              <Markdown text={value} />
            </div>
          )
        ) : (
          <CodeEditor language="markdown" value={value} readOnly={streaming} onChange={setDraft} />
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-3 py-2">
        {activeView === "edit" && (
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-40"
          >
            <Save size={12} />
            Save
          </button>
        )}
        {plugin &&
          (canRun ? (
            <button
              type="button"
              onClick={running ? handleStop : handleRun}
              disabled={streaming}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40 ${
                running
                  ? "border border-border bg-canvas text-fg-dim hover:bg-bg-hover hover:text-fg"
                  : "bg-accent text-on-accent hover:bg-accent-hover"
              }`}
            >
              {running ? (
                <>
                  <Square size={11} /> Stop
                </>
              ) : (
                <>
                  <Play size={12} /> Run
                </>
              )}
            </button>
          ) : (
            <Tooltip label={`Install the ${plugin.name} plugin to run this in your browser`}>
              <button
                type="button"
                onClick={onOpenPlugins}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-canvas px-3 py-1.5 text-xs font-medium text-fg-dim transition-colors hover:bg-bg-hover hover:text-fg"
              >
                <Puzzle size={12} />
                Install {plugin.name} to run this
              </button>
            </Tooltip>
          ))}
        {artifact.type === "document" ? (
          <>
            {artifact.format !== "pdf" && (
              <button
                type="button"
                onClick={() => void handleExportDoc("docx")}
                disabled={streaming || exporting !== null}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-canvas px-3 py-1.5 text-xs font-medium text-fg-dim transition-colors hover:bg-bg-hover hover:text-fg disabled:opacity-40"
              >
                {exporting === "docx" ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                Word (.docx)
              </button>
            )}
            {artifact.format !== "docx" && (
              <button
                type="button"
                onClick={() => void handleExportDoc("pdf")}
                disabled={streaming || exporting !== null}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-canvas px-3 py-1.5 text-xs font-medium text-fg-dim transition-colors hover:bg-bg-hover hover:text-fg disabled:opacity-40"
              >
                {exporting === "pdf" ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                PDF
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            onClick={handleDownload}
            disabled={streaming}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-canvas px-3 py-1.5 text-xs font-medium text-fg-dim transition-colors hover:bg-bg-hover hover:text-fg disabled:opacity-40"
          >
            <Download size={12} />
            Download
          </button>
        )}
      </div>
    </div>
  );
}
