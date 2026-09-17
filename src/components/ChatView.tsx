import { useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, Ghost, GripVertical, Loader2 } from "lucide-react";
import type { Attachment, ChatMessage, Conversation, GeneratedArtifact, OmniModel } from "../lib/types";
import type { CapabilityIndex, ModelCapabilities } from "../lib/capabilities";
import type { Skill } from "../lib/skills";
import { MessageBubble } from "./MessageBubble";
import { Welcome } from "./Welcome";
import { Composer } from "./Composer";
import { ChatHeader } from "./ChatHeader";
import { GenerationPanel, type GenerationMode } from "./GenerationPanel";
import { ArtifactPanel } from "./ArtifactPanel";

export interface GenRequest {
  mode: GenerationMode;
  prompt?: string;
  image?: { dataUrl: string; name?: string } | null;
  initialImage?: { dataUrl: string; name?: string } | null;
}

/**
 * Cheap, synchronous height guess used only until a row is actually measured
 * post-mount — it doesn't need to be exact, just closer than a flat constant
 * so the virtualizer needs fewer resize corrections to settle on first open
 * (see the estimateSize prop below and the `anchorTo: "end"` option, which
 * keeps the viewport pinned to the bottom while rows above correct from this
 * estimate to their real measured size).
 */
function estimateMessageHeight(message: ChatMessage | undefined): number {
  if (!message) return 120;
  const len = message.content?.length ?? 0;
  const fenceCount = Math.floor((message.content?.match(/```/g)?.length ?? 0) / 2);
  const attachmentCount = message.attachments?.length ?? 0;
  const fileCount = message.files?.length ?? 0;
  const proseLines = Math.ceil(len / 70); // ~reading-column width at base font size
  // 250, not 220: each fenced block now carries a language/copy header row.
  const estimate = 96 + proseLines * 24 + fenceCount * 250 + attachmentCount * 90 + fileCount * 110;
  return Math.min(Math.max(estimate, 72), 2400);
}

interface ChatViewProps {
  conversation: Conversation | null;
  model: string;
  streaming: boolean;
  searching: boolean;
  caps: ModelCapabilities;
  skills: Skill[];
  activeSkillNames: string[];
  temporary: boolean;
  searchEnabled: boolean;
  models: OmniModel[];
  capabilityIndex: CapabilityIndex;
  genRequest: GenRequest | null;
  generating: boolean;
  onToggleSearch: () => void;
  onToggleTemporary: () => void;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  onEditMessage: (messageId: string, newText: string) => void;
  onOpenModelPicker: () => void;
  onRenameConversation: (id: string, title: string) => void;
  onRetry: (messageId: string) => void;
  onOpenGenerate: (
    mode: GenerationMode,
    opts?: { prompt?: string; image?: { dataUrl: string; name?: string } }
  ) => void;
  onCloseGenerate: () => void;
  onGenerate: (input: {
    mode: GenerationMode;
    prompt: string;
    model: string;
    image: string | File | null;
  }) => void;
  onReadDocument: (prompt: string, attachments: Attachment[]) => void;
  openArtifact: {
    messageId: string;
    artifact: GeneratedArtifact;
    resolvedModel?: string;
    provider?: string;
  } | null;
  artifactPanelWidth: number;
  onOpenArtifact: (messageId: string, artifactId: string) => void;
  onCloseArtifact: () => void;
  onEditArtifact: (messageId: string, artifactId: string, content: string) => void;
  onResizeArtifactPanel: (width: number) => void;
  onOpenPlugins: () => void;
}

export function ChatView({
  conversation,
  model,
  streaming,
  searching,
  caps,
  skills,
  activeSkillNames,
  temporary,
  searchEnabled,
  models,
  capabilityIndex,
  genRequest,
  generating,
  onToggleSearch,
  onToggleTemporary,
  onSend,
  onStop,
  onEditMessage,
  onOpenModelPicker,
  onRenameConversation,
  onRetry,
  onOpenGenerate,
  onCloseGenerate,
  onGenerate,
  onReadDocument,
  openArtifact,
  artifactPanelWidth,
  onOpenArtifact,
  onCloseArtifact,
  onEditArtifact,
  onResizeArtifactPanel,
  onOpenPlugins,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const resizingRef = useRef(false);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const messages = conversation?.messages ?? [];

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const stuck = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickRef.current = stuck;
    setShowScrollButton(!stuck);
  };

  // Windowed rendering — every message is a real, fully mounted MessageBubble
  // (markdown, syntax highlighting, artifact cards), which gets laggy once a
  // conversation grows long. Dynamic measureElement sizing handles the huge
  // variance in message height (one-line reply vs. code blocks/images), the
  // same pattern already proven in ModelPickerModal. `estimateSize` uses a
  // content-derived guess (rather than a flat constant) and `overscan` is
  // kept low, so opening a big/content-heavy conversation mounts as few
  // heavy bubbles as possible before the real measurements settle in.
  // `anchorTo: "end"` keeps the viewport pinned to the bottom while rows
  // above resize from their estimate to their measured size during that
  // settle, instead of visibly jumping around.
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimateMessageHeight(messages[index]),
    // Keyed by message id, not index: editing or retrying truncates the list,
    // and an index-keyed measurement cache would then apply an old message's
    // measured height to whichever message takes its place.
    getItemKey: (index) => messages[index]?.id ?? index,
    overscan: 3,
    anchorTo: "end",
    // The list's top/bottom breathing room (matches the old wrapper's
    // `py-6`) has to be virtualizer-owned padding, not CSS padding on a
    // wrapper around the sized `getTotalSize()` div: react-virtual's own
    // scroll math (getTotalSize, scrollToIndex's offset calc) only knows
    // about item positions plus paddingStart/paddingEnd - it has no way to
    // see a plain CSS padding sitting outside what it measures. With that
    // padding invisible to it, scrollToIndex({align:"end"}) on conversation
    // entry landed short of the real bottom by roughly the padding amount
    // (the DOM's true scrollHeight was taller than the virtualizer's model),
    // which is what "doesn't scroll all the way down" looked like.
    paddingStart: 24,
    paddingEnd: 24,
    // scrollToIndex (called below from useLayoutEffect, i.e. during React's
    // own commit phase) triggers a synchronous internal update that
    // react-virtual flushes via react-dom's flushSync by default - React
    // disallows flushSync while it's already mid-render/commit and warns
    // "flushSync was called from inside a lifecycle method". useFlushSync:
    // false is react-virtual's own documented opt-out: it re-renders through
    // a normal state update instead, which still commits before paint here
    // since every call site is itself a useLayoutEffect.
    useFlushSync: false,
  });

  // useLayoutEffect (not useEffect) so the measurement-cache reset and the
  // bottom-jump effect below both commit before the browser paints — a plain
  // useEffect runs one frame after paint, which is the visible "flash of
  // stale layout, then snap" a conversation switch used to show.
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [conversation?.id, virtualizer]);

  // virtualizer.scrollToIndex({align: "end"}) only aligns the target item's
  // own bottom edge with the viewport - it does not extend to the
  // container's true scrollable end (paddingEnd, or a last row whose size
  // is still an estimate at call time), so on its own it can leave the
  // view short of the real bottom by tens of pixels. scrollToIndex is still
  // needed first: it's what makes react-virtual mount the target row at
  // all when it isn't already in the virtualized window. The native
  // scrollTop snap afterward is what actually guarantees "all the way
  // down" - el.scrollHeight always equals the wrapper's own
  // getTotalSize()-driven height (that div's height comes from that number
  // directly, not from laying out its children), so it's authoritative
  // regardless of which rows happen to be mounted yet.
  const snapToBottom = () => {
    if (messages.length === 0) return;
    virtualizer.scrollToIndex(messages.length - 1, { align: "end" });
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const scrollToBottom = () => {
    stickRef.current = true;
    setShowScrollButton(false);
    snapToBottom();
  };

  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      onResizeArtifactPanel(window.innerWidth - ev.clientX);
    };
    const onUp = () => {
      resizingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const lastMessage = messages[messages.length - 1];

  useLayoutEffect(() => {
    if (stickRef.current && messages.length > 0) {
      snapToBottom();
    }
  }, [
    conversation?.id,
    messages.length,
    lastMessage?.content.length,
    lastMessage?.reasoning?.length,
  ]);

  const isEmpty = !conversation || conversation.messages.length === 0;

  return (
    <div className="relative flex h-full min-w-0 flex-1 overflow-hidden">
    <div className="relative isolate flex h-full min-w-0 flex-1 flex-col">
      {isEmpty && <div className="brand-gradient-wash" aria-hidden />}
      <ChatHeader
        conversation={conversation}
        temporary={temporary}
        onToggleTemporary={onToggleTemporary}
        onRenameConversation={onRenameConversation}
      />

      <div ref={scrollRef} onScroll={onScroll} className="chat-scroll flex-1 overflow-y-auto">
        {isEmpty ? (
          <div className="flex min-h-full items-start justify-center py-6">
            {temporary ? (
              <div className="mx-auto flex w-full max-w-2xl flex-col items-center px-4 pt-12 pb-6">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-on-accent">
                  <Ghost size={24} />
                </div>
                <h1 className="mt-4 font-display text-3xl font-normal tracking-[-0.02em]">
                  Temporary chat
                </h1>
                <p className="mt-1 text-center text-sm text-fg-dim">
                  Your messages won’t be saved to history.
                </p>
              </div>
            ) : (
              <Welcome onPick={(prompt) => onSend(prompt, [])} caps={caps} />
            )}
          </div>
        ) : (
          // Vertical breathing room comes from the virtualizer's own
          // paddingStart/paddingEnd (see useVirtualizer above), not CSS
          // padding here - see that option's comment for why.
          <div data-ui="measure" className="mx-auto w-full px-4">
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const message = messages[virtualRow.index];
                return (
                  <div
                    key={message.id}
                    ref={virtualizer.measureElement}
                    data-index={virtualRow.index}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <div className="pb-6">
                      <MessageBubble
                        message={message}
                        skills={skills}
                        prevUserSearchResults={messages[virtualRow.index - 1]?.search?.results}
                        streaming={streaming && virtualRow.index === messages.length - 1}
                        onRetry={onRetry}
                        onEdit={onEditMessage}
                        onOpenArtifact={onOpenArtifact}
                        activeArtifactId={openArtifact?.messageId === message.id ? openArtifact.artifact.id : undefined}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {showScrollButton && !isEmpty && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-28 left-1/2 z-20 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-bg-elevated text-fg-dim shadow-lift transition-colors hover:bg-bg-hover hover:text-fg"
        >
          <ArrowDown size={16} />
        </button>
      )}

      {searching && (
        <div data-ui="measure" className="mx-auto flex w-full items-center gap-2 px-4 pb-2 text-xs text-fg-faint">
          <Loader2 size={14} className="animate-spin" />
          <span>Searching the web…</span>
        </div>
      )}

      <Composer
        model={model}
        hasModels={models.length > 0}
        caps={caps}
        streaming={streaming}
        skills={skills}
        activeSkillNames={activeSkillNames}
        searchEnabled={searchEnabled}
        searching={searching}
        onToggleSearch={onToggleSearch}
        onSend={onSend}
        onStop={onStop}
        onOpenModelPicker={onOpenModelPicker}
        onOpenGenerate={onOpenGenerate}
        onReadDocument={onReadDocument}
      />

      {genRequest && (
        <GenerationPanel
          mode={genRequest.mode}
          models={models}
          index={capabilityIndex}
          initialPrompt={genRequest.prompt}
          initialImage={genRequest.initialImage ?? genRequest.image ?? null}
          busy={generating}
          onClose={onCloseGenerate}
          onSubmit={onGenerate}
        />
      )}
    </div>

      {openArtifact && (
        <div
          className="relative hidden shrink-0 md:flex"
          style={{ width: artifactPanelWidth }}
        >
          <div
            onMouseDown={startResize}
            className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize select-none"
          >
            <div className="mx-auto flex h-full w-px items-center justify-center bg-border-subtle">
              <GripVertical size={12} className="text-fg-faint" />
            </div>
          </div>
          <div className="flex h-full min-w-0 flex-1 flex-col border-l border-border-subtle bg-bg-elevated">
            <ArtifactPanel
              artifact={openArtifact.artifact}
              resolvedModel={openArtifact.resolvedModel}
              provider={openArtifact.provider}
              onClose={onCloseArtifact}
              onChange={(content) => onEditArtifact(openArtifact.messageId, openArtifact.artifact.id, content)}
              onOpenPlugins={onOpenPlugins}
            />
          </div>
        </div>
      )}

      {openArtifact && (
        <div className="fixed inset-0 z-40 flex flex-col md:hidden">
          <div className="absolute inset-0 bg-overlay/60" onClick={onCloseArtifact} />
          <div className="relative z-10 mt-auto flex h-[85%] flex-col overflow-hidden rounded-t-2xl border-t border-border bg-bg-elevated shadow-lift">
            <ArtifactPanel
              artifact={openArtifact.artifact}
              resolvedModel={openArtifact.resolvedModel}
              provider={openArtifact.provider}
              onClose={onCloseArtifact}
              onChange={(content) => onEditArtifact(openArtifact.messageId, openArtifact.artifact.id, content)}
              onOpenPlugins={onOpenPlugins}
            />
          </div>
        </div>
      )}
    </div>
  );
}
