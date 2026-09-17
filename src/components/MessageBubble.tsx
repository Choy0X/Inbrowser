import { memo, useEffect, useState, useMemo } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Copy,
  Cpu,
  Download,
  Edit2,
  Globe,
  RotateCcw,
  Square,
  Wrench,
  Volume2,
} from "lucide-react";
import type { ChatMessage, GeneratedMedia, MessageSearch, SearchResult } from "../lib/types";
import type { Skill } from "../lib/skills";
import { splitTextBySkillTokens } from "../lib/skills";
import { downloadArtifact } from "../lib/artifactDownload";
import { responseProxyLabel } from "../lib/gateway/responseProxy";
import { cleanProtocolOutput } from "../lib/gateway/protocolOutput";
import { Markdown, CitedMarkdown } from "./Markdown";
import { Mark } from "./Mark";
import { Tooltip } from "./Tooltip";
import { ArtifactBlock } from "./ArtifactBlock";
import { SkillInfoDialog } from "./skills/SkillInfoDialog";
import { showBrowser } from "../lib/tools/browserSession";

/**
 * Compact time for a message's toolbar; full date/time is in the title attribute.
 * A bare time reads as "today" — prefix the date once the message is from an
 * earlier day so old messages don't look like they just arrived.
 */
function formatMessageTime(timestamp: number): string {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) return time;
  const sameYear = date.getFullYear() === now.getFullYear();
  const day = date.toLocaleDateString([], sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  return `${day}, ${time}`;
}

function MessageTimestamp({ timestamp }: { timestamp: number }) {
  return (
    <Tooltip label={new Date(timestamp).toLocaleString()}>
      <span className="text-[11px] text-fg-faint">{formatMessageTime(timestamp)}</span>
    </Tooltip>
  );
}

function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(streaming);

  // While the model is still generating (reasoning streaming in) keep the block
  // expanded; the moment the response finishes, fold it away. Manual clicks
  // still work — this only fires on `streaming` transitions, so collapsed older
  // messages and manually-reopened ones are left alone.
  useEffect(() => {
    setOpen(streaming);
  }, [streaming]);

  return (
    <div className="mb-2 rounded-lg border border-border-subtle bg-bg-elevated/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-sm text-fg-dim hover:text-fg"
      >
        <ChevronDown size={14} className={`transition-transform ${open ? "rotate-180" : ""}`} />
        <span className="font-medium">Thinking</span>
        {streaming && <span className="text-xs text-fg-faint">…</span>}
      </button>
      {open && (
        <div className="border-t border-border-subtle px-3 py-2 text-sm leading-6 text-fg-dim">
          <Markdown text={text} streaming={streaming} />
        </div>
      )}
    </div>
  );
}

function UserBubble({
  message,
  skills,
  onEdit,
}: {
  message: ChatMessage;
  skills: Skill[];
  onEdit: (text: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(message.content || "");
  const [infoSkillId, setInfoSkillId] = useState<string | null>(null);
  const infoSkill = skills.find((s) => s.id === infoSkillId) ?? null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const handleEdit = () => {
    if (!editText.trim()) return;
    setEditing(false);
    onEdit(editText);
  };

  return (
    <div className="flex justify-end">
      <div data-ui="turn" data-role="user">
        {message.attachments && message.attachments.length > 0 && (
          <div className="mb-2 grid grid-cols-2 gap-2 sm:max-w-md">
            {message.attachments.map((att) => {
              return att.kind === "image" && att.dataUrl ? (
                <img
                  key={att.id}
                  src={att.dataUrl}
                  alt={att.name}
                  className="max-h-48 w-full rounded-lg border border-border-subtle object-cover"
                />
              ) : (
                <Tooltip key={att.id} label={att.name}>
                  <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-elevated px-3 py-2 text-xs text-fg-dim">
                    <span className="truncate">{att.name}</span>
                  </div>
                </Tooltip>
              );
            })}
          </div>
        )}
        {message.content && (
          <>
            {!editing && (
              <div data-ui="turn-body" data-role="user" className="text-[15px] leading-7 whitespace-pre-wrap">
                {splitTextBySkillTokens(message.content, skills).map((segment, i) =>
                  "skill" in segment ? (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setInfoSkillId(segment.skill.id)}
                      className="rounded px-0.5 font-medium text-accent hover:underline"
                    >
                      {segment.raw}
                    </button>
                  ) : (
                    <span key={i}>{segment.text}</span>
                  )
                )}
              </div>
            )}
            {!editing && (
              <div className="mt-1 flex items-center justify-end gap-2">
                <MessageTimestamp timestamp={message.timestamp} />
                <div className="flex items-center gap-1">
                  <Tooltip label={copied ? "Copied!" : "Copy"}>
                    <button
                      type="button"
                      onClick={copy}
                      className="rounded-full border border-border bg-canvas p-1 text-fg-faint hover:bg-bg-hover hover:text-fg transition-colors"
                      aria-label={copied ? "Copied!" : "Copy"}
                    >
                      {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                    </button>
                  </Tooltip>
                  <Tooltip label="Edit message">
                    <button
                      type="button"
                      onClick={() => { setEditText(message.content || ""); setEditing(true); }}
                      className="rounded-full border border-border bg-canvas p-1 text-fg-faint hover:bg-bg-hover hover:text-fg transition-colors"
                      aria-label="Edit message"
                    >
                      <Edit2 size={12} />
                    </button>
                  </Tooltip>
                </div>
              </div>
            )}
            {editing && (
              <div data-ui="turn-body" data-role="user">
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  className="w-full min-h-[60px] resize-none bg-transparent text-[15px] leading-7 outline-none"
                  rows={3}
                />
                <div className="mt-2 flex items-center gap-2 justify-end">
                  <button
                    type="button"
                    onClick={() => { setEditing(false); }}
                    className="rounded-md border border-border bg-canvas px-3 py-1.5 text-sm hover:bg-bg-hover"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleEdit}
                    className="rounded-md bg-accent px-3 py-1.5 text-sm text-on-accent hover:bg-accent-hover"
                  >
                    Save
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        {message.search && <SearchCard search={message.search} />}
      </div>
      <SkillInfoDialog skill={infoSkill} onClose={() => setInfoSkillId(null)} />
    </div>
  );
}

/** Collapsible card showing web search sources attached to a user message. */
function SearchCard({ search }: { search: MessageSearch }) {
  const [open, setOpen] = useState(false);

  if (search.error) {
    return (
      <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-xs text-error">
        <Globe size={13} className="shrink-0" />
        <span className="min-w-0">
          Web search failed: <span className="opacity-80">{search.error}</span>
        </span>
      </div>
    );
  }

  const count = search.results.length;
  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-dashed border-border-subtle bg-bg-elevated/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-fg-dim hover:text-fg"
      >
        <Globe size={14} className="shrink-0 text-accent" />
        <span className="font-medium">Web search</span>
        <span className="rounded-full border border-border-subtle px-1.5 py-0.5 text-[10px] text-fg-faint">
          {count} result{count === 1 ? "" : "s"}
        </span>
        <span className="ml-auto min-w-0 truncate text-fg-faint">{search.query}</span>
        <ChevronDown size={14} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul className="space-y-0.5 border-t border-border-subtle px-2 py-2">
          {search.results.map((r) => (
            <li key={r.url}>
              <a
                href={r.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-bg-hover"
              >
                <span className="mt-0.5 shrink-0 text-[10px] font-medium leading-4 text-fg-faint">
                  {r.position ?? ""}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-fg">{r.title}</span>
                  {r.snippet && (
                    <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-fg-dim">
                      {r.snippet}
                    </span>
                  )}
                  {r.displayUrl && (
                    <span className="mt-0.5 block truncate text-[11px] text-fg-faint">
                      {r.displayUrl}
                    </span>
                  )}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Read the message aloud with the browser TTS engine. */
function useSpeech(content: string) {
  const [speaking, setSpeaking] = useState(false);
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;

  useEffect(() => {
    return () => {
      if (supported) window.speechSynthesis.cancel();
    };
  }, [supported]);

  const toggle = () => {
    if (!supported) return;
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    const utter = new SpeechSynthesisUtterance(content);
    utter.onend = () => setSpeaking(false);
    utter.onerror = () => setSpeaking(false);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
    setSpeaking(true);
  };

  return { supported, speaking, toggle };
}

/** Render generated images/videos (from image/video generation endpoints). */
function MediaBlock({ media }: { media: GeneratedMedia[] }) {
  return (
    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
      {media.map((m, i) =>
        m.kind === "image" ? (
          <img
            key={i}
            src={m.url}
            alt={m.prompt}
            className="w-full rounded-lg border border-border-subtle object-cover"
            loading="lazy"
          />
        ) : (
          <video
            key={i}
            src={m.url}
            controls
            className="w-full rounded-lg border border-border-subtle bg-black"
          />
        )
      )}
    </div>
  );
}

interface AssistantProps {
  message: ChatMessage;
  prevUserSearchResults?: SearchResult[];
  streaming: boolean;
  onRetry: (messageId: string) => void;
  onOpenArtifact: (messageId: string, artifactId: string) => void;
  onEditCodeBlock?: (messageId: string, key: string, content: string | null) => void;
  onOpenPlugins?: () => void;
  activeArtifactId?: string;
}
function AssistantBubble({
  message,
  prevUserSearchResults,
  streaming,
  onRetry,
  onOpenArtifact,
  onEditCodeBlock,
  onOpenPlugins,
  activeArtifactId,
}: AssistantProps) {
  const [copied, setCopied] = useState(false);
  const displayContent = useMemo(() => cleanProtocolOutput(message.content), [message.content]);
  const { supported: canSpeak, speaking, toggle: toggleSpeech } = useSpeech(displayContent);
  const files = message.files ?? [];
  const singleFile = files.length === 1 ? files[0] : null;

  // No message text to copy for a file-only reply — copy the file's own
  // content instead, so "Copy" still does something sensible rather than
  // just disappearing. Ambiguous with 2+ files, so copy is hidden then.
  const copy = async () => {
    const text = displayContent || (singleFile ? singleFile.editedContent ?? singleFile.content : "");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  // Identity-stable so the memoized components map inside Markdown isn't
  // rebuilt every render — rebuilding it remounts each InlineCodeFile and
  // discards its draft and run output.
  const interactive = useMemo(
    () => ({
      codeEdits: message.codeEdits,
      onEditCodeBlock: onEditCodeBlock
        ? (key: string, content: string | null) => onEditCodeBlock(message.id, key, content)
        : undefined,
      onOpenPlugins,
    }),
    [message.codeEdits, message.id, onEditCodeBlock, onOpenPlugins]
  );

  return (
    <div className="group flex gap-3">
      <div
        data-ui="avatar"
        className="mt-1 h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-on-accent"
      >
        <Mark size={15} />
      </div>
      <div data-ui="turn" data-role="assistant" className="min-w-0 flex-1 border border-transparent px-3 py-2">
        {message.reasoning && <ThinkingBlock text={message.reasoning} streaming={streaming} />}
        {displayContent ? (
          prevUserSearchResults && prevUserSearchResults.length > 0 ? (
            <CitedMarkdown
              text={displayContent}
              citations={prevUserSearchResults}
              streaming={streaming}
              interactiveCode
              interactive={interactive}
            />
          ) : (
            <Markdown
              text={displayContent}
              streaming={streaming}
              interactiveCode
              interactive={interactive}
            />
          )
        ) : streaming ? (
          <div className="flex items-center gap-2 py-1 text-fg-dim">
            <span className="inline-block h-2 w-2 rounded-full bg-fg-dim animate-blink" />
            <span className="text-sm">Thinking…</span>
          </div>
        ) : null}
        {message.media && message.media.length > 0 && <MediaBlock media={message.media} />}
        {message.files && message.files.length > 0 && (
          <ArtifactBlock
            artifacts={message.files}
            activeArtifactId={activeArtifactId}
            onOpen={(artifactId) => onOpenArtifact(message.id, artifactId)}
          />
        )}
        {streaming && displayContent && <span className="animate-blink text-accent">▍</span>}
        {message.error && (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-error">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="font-medium">Request failed</div>
              <div className="mt-0.5 whitespace-pre-line break-words opacity-80">{message.error}</div>
              <button
                type="button"
                onClick={() => onRetry(message.id)}
                className="mt-2 rounded-md border border-border bg-canvas px-2.5 py-1 text-xs hover:bg-bg-hover"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {message.role === "assistant" && message.proxy && (
          <div data-ui="meta" className="mt-2 flex min-w-0 items-start gap-1.5 text-[11px] text-fg-faint">
            <Globe size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span className="break-all">Proxy: {responseProxyLabel(message.proxy)}</span>
          </div>
        )}
        {!streaming && (displayContent || files.length > 0) && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <MessageTimestamp timestamp={message.timestamp} />
            {message.resolvedModel && (
              <span
                data-ui="meta"
                className="flex items-center gap-1.5 rounded-full bg-night px-2.5 py-1 text-[11px] text-on-night"
              >
                <Cpu size={12} className="shrink-0 text-accent" />
                <span className="truncate">
                  Model · {message.resolvedModel}
                  {message.provider && message.provider !== message.resolvedModel
                    ? ` (${message.provider})`
                    : ""}
                </span>
              </span>
            )}
            <div className="flex items-center gap-1">
              {(displayContent || singleFile) && (
                <Tooltip label={copied ? "Copied!" : displayContent ? "Copy" : "Copy file"}>
                  <button
                    type="button"
                    onClick={() => void copy()}
                    className="rounded-full border border-border bg-canvas p-1.5 text-fg-faint transition-colors hover:bg-bg-hover hover:text-fg"
                  >
                    {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
                  </button>
                </Tooltip>
              )}
              {singleFile && (
                <Tooltip label="Download">
                  <button
                    type="button"
                    onClick={() => downloadArtifact(singleFile)}
                    className="rounded-full border border-border bg-canvas p-1.5 text-fg-faint transition-colors hover:bg-bg-hover hover:text-fg"
                  >
                    <Download size={14} />
                  </button>
                </Tooltip>
              )}
              <Tooltip label="Regenerate">
                <button
                  type="button"
                  onClick={() => onRetry(message.id)}
                  className="rounded-full border border-border bg-canvas p-1.5 text-fg-faint transition-colors hover:bg-bg-hover hover:text-fg"
                >
                  <RotateCcw size={14} />
                </button>
              </Tooltip>
              {canSpeak && displayContent && (
                <Tooltip label={speaking ? "Stop reading" : "Read aloud"}>
                  <button
                    type="button"
                    onClick={toggleSpeech}
                    className={`rounded-full border p-1.5 transition-colors ${
                      speaking
                        ? "border-accent bg-accent text-on-accent"
                        : "border-border bg-canvas text-fg-faint hover:bg-bg-hover hover:text-fg"
                    }`}
                  >
                    {speaking ? <Square size={13} fill="currentColor" /> : <Volume2 size={14} />}
                  </button>
                </Tooltip>
              )}
            </div>
          </div>
        )}

        {message.provider && !message.resolvedModel && !streaming && (
          <div data-ui="meta" className="mt-1 flex items-center gap-1.5 text-xs text-fg-faint">
            <Check size={12} />
            <span className="truncate">via {message.provider}</span>
          </div>
        )}
      </div>
    </div>
  );
}

interface MessageBubbleProps {
  message: ChatMessage;
  /** Search results attached to the preceding user turn, for inline citations — a stable
   *  array reference (unlike the whole `conversation`/`index` this used to be derived from)
   *  so unrelated bubbles can be memoized out of re-rendering while another message streams. */
  prevUserSearchResults?: SearchResult[];
  /** For highlighting `/<slug>` skill tokens in a sent user message the same way the composer does. */
  skills: Skill[];
  streaming: boolean;
  onRetry: (messageId: string) => void;
  onEdit?: (messageId: string, newText: string) => void;
  onOpenArtifact?: (messageId: string, artifactId: string) => void;
  /** Persists a user edit to one inline fenced code block; `null` reverts it. */
  onEditCodeBlock?: (messageId: string, key: string, content: string | null) => void;
  onOpenPlugins?: () => void;
  activeArtifactId?: string;
}

/**
 * Memoized so a message whose own props didn't change (the common case for
 * every bubble except the one actively streaming) skips re-running its
 * markdown parse + syntax highlighting on every token appended to a
 * *different* message. Requires every prop here to be reference-stable
 * across unrelated re-renders — see ChatView.tsx's call site, which passes
 * the top-level onRetry/onEdit/onOpenArtifact callbacks straight through
 * (no per-message wrapper closures) and a stable prevUserSearchResults array.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  prevUserSearchResults,
  skills,
  streaming,
  onRetry,
  onEdit,
  onOpenArtifact,
  onEditCodeBlock,
  onOpenPlugins,
  activeArtifactId,
}: MessageBubbleProps) {
  if (message.role === "tool") return null;
  if (message.role === "system") return null;
  if (message.role === "user")
    return (
      <UserBubble
        message={message}
        skills={skills}
        onEdit={onEdit ? (text) => onEdit(message.id, text) : () => {}}
      />
    );
  // Assistant turn that only requested tool calls (content produced in a later turn).
  if ((message.toolCalls && message.toolCalls.length > 0) && !message.content.trim())
    return <ToolCallsChip message={message} />;
  return (
    <AssistantBubble
      message={message}
      prevUserSearchResults={prevUserSearchResults}
      streaming={streaming}
      onRetry={onRetry}
      onOpenArtifact={onOpenArtifact ?? (() => {})}
      onEditCodeBlock={onEditCodeBlock}
      onOpenPlugins={onOpenPlugins}
      activeArtifactId={activeArtifactId}
    />
  );
});

function ToolCallsChip({ message }: { message: ChatMessage }) {
  const toolNames = (message.toolCalls ?? []).map((t) => t.name).filter(Boolean);
  const names = toolNames.join(", ");
  // The browser tools share one live session/panel (browserSession.ts) that
  // survives across the whole chat until cleared, so a past "browser_open"/
  // "browser_search" chip can bring the dock back into view without needing
  // to redo the fetch — reuse it rather than re-running the tool call.
  const canReopenBrowser = toolNames.some((name) => name.startsWith("browser_"));

  const chip = (
    <span className="flex items-center gap-1.5 rounded-full border border-border-subtle bg-bg-elevated/70 px-3 py-1 text-xs text-fg-dim">
      <Wrench size={12} className="text-accent" />
      <span className="truncate">Using tools: {names || "…"}</span>
    </span>
  );

  return (
    <div className="flex justify-center py-0.5">
      {canReopenBrowser ? (
        <Tooltip label="Reopen the browser panel">
          <button type="button" onClick={() => showBrowser()} className="transition-opacity hover:opacity-80">
            {chip}
          </button>
        </Tooltip>
      ) : (
        chip
      )}
    </div>
  );
}
