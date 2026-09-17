import { useEffect, useRef, useState } from "react";
import { Ghost } from "lucide-react";
import type { Conversation } from "../lib/types";
import { IconButton } from "./ui";
import { Tooltip } from "./Tooltip";

interface ChatHeaderProps {
  conversation: Conversation | null;
  temporary: boolean;
  onToggleTemporary: () => void;
  onRenameConversation: (id: string, title: string) => void;
}

/**
 * Compact, persistent bar above the chat scroll region — the one thing
 * every other route already gets from PageShell but chat, which owns its
 * own virtualized scrolling, never had. Left padding on mobile leaves room
 * for Sidebar's floating hamburger (fixed left-3 top-3, ~44px), which stays
 * put rather than being duplicated in here — that button also opens the
 * drawer on every other route, so it can't move into a chat-only header.
 */
export function ChatHeader({
  conversation,
  temporary,
  onToggleTemporary,
  onRenameConversation,
}: ChatHeaderProps) {
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  const title = conversation?.title || "New chat";
  // A real conversation locks in as either temporary or not the moment it
  // has a first message — flipping `temporary` on an already-started chat
  // later gets it swept up by the "discard all temporary chats" filter and
  // wipes it out from under the user, so the control is disabled past that
  // point rather than left free to relabel (and effectively delete) it.
  const started = (conversation?.messages.length ?? 0) > 0;

  const startRename = () => {
    if (!conversation) return;
    setDraftTitle(conversation.title);
    setRenaming(true);
  };

  const commitRename = () => {
    const next = draftTitle.trim();
    if (conversation && next && next !== conversation.title) {
      onRenameConversation(conversation.id, next);
    }
    setRenaming(false);
  };

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-canvas pl-14 pr-3 md:pl-4">
      {renaming ? (
        <input
          ref={inputRef}
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          onBlur={commitRename}
          className="min-w-0 flex-1 rounded-md border border-accent bg-canvas px-2 py-1 text-[15px] font-medium text-fg outline-none"
        />
      ) : (
        <Tooltip label={title}>
          <h1
            data-ui="display"
            onDoubleClick={startRename}
            className="min-w-0 flex-1 truncate text-[15px] text-fg"
          >
            {title}
          </h1>
        </Tooltip>
      )}

      <IconButton
        label={
          started
            ? "Temporary chat can only be turned on before the first message"
            : temporary
              ? "Turn off temporary chat"
              : "Turn on temporary chat (not saved to history)"
        }
        icon={<Ghost size={16} />}
        size="sm"
        variant={temporary ? "primary" : "ghost"}
        disabled={started}
        onClick={onToggleTemporary}
      />
    </div>
  );
}
