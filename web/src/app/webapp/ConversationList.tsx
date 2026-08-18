"use client";

import { Pin, PinOff } from "lucide-react";
import { useT } from "@/i18n/LanguageProvider";
import { groupConversations, type BucketId } from "./lib/historyGroups";
import type { Conversation } from "./conversationsApi";

/**
 * The chat history in the sidebar: past conversations under Pinned / Today / Yesterday / …, each one a
 * button that reopens it.
 *
 * Presentational on purpose — it fetches nothing and owns no data. The sidebar renders its body TWICE
 * (a persistent rail on desktop, a slide-in overlay on mobile), so anything that loaded here would load
 * twice and anything remembered here would exist as two disagreeing copies. Chat.tsx owns the list.
 *
 * Pinning is a plain button rather than a per-row overflow menu, which is what a longer list of row
 * actions would need: a menu would have to be portalled to document.body to escape both the mobile
 * drawer's transform and the rail's clipping, and one toggle doesn't earn that.
 */
export default function ConversationList({
  conversations,
  activeId,
  loading,
  onOpen,
  onTogglePin,
}: {
  conversations: Conversation[];
  /** The conversation currently on screen, highlighted. Null while a brand-new chat is still empty. */
  activeId: string | null;
  loading: boolean;
  onOpen: (conversationId: string) => void;
  onTogglePin: (conversationId: string, pinned: boolean) => void;
}) {
  const t = useT();
  const groups = groupConversations(conversations);

  const heading: Record<BucketId, string> = {
    pinned: t.history.pinned,
    today: t.history.today,
    yesterday: t.history.yesterday,
    last7: t.history.last7,
    last30: t.history.last30,
    older: t.history.older,
  };

  // The list is the sidebar's flexible middle: it takes the space the nav and the account block don't,
  // and scrolls inside it rather than pushing them off the ends.
  return (
    <div className="-mx-1 mt-2 min-h-0 flex-1 overflow-y-auto px-1">
      {conversations.length === 0 && (
        <p className="px-3 py-2 text-xs text-black/40 dark:text-white/40">
          {loading ? t.history.loading : t.history.empty}
        </p>
      )}

      {groups.map((group) => (
        <section key={group.id} className="mb-1">
          <h3 className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-black/40 uppercase dark:text-white/40">
            {heading[group.id]}
          </h3>
          <ul>
            {group.conversations.map((c) => {
              const active = c.conversationId === activeId;
              return (
                <li key={c.conversationId} className="flex items-center gap-0.5">
                  <button
                    onClick={() => onOpen(c.conversationId)}
                    // aria-current, not just a background: which chat you are in is information, and a
                    // screen reader gets nothing from a tint.
                    aria-current={active ? "true" : undefined}
                    className={`min-w-0 flex-1 truncate rounded-lg px-3 py-2 text-left text-sm transition ${
                      active
                        ? "bg-black/5 font-medium text-black/80 dark:bg-white/10 dark:text-white/80"
                        : "text-black/70 hover:bg-black/5 dark:text-white/70 dark:hover:bg-white/10"
                    }`}
                  >
                    {/* A conversation opened with something that left no text — a photo with no caption —
                        has no words to be titled after, so it borrows the label a new chat starts with. */}
                    {c.title || t.history.untitled}
                  </button>
                  <button
                    onClick={() => onTogglePin(c.conversationId, !c.pinned)}
                    title={c.pinned ? t.history.unpin : t.history.pin}
                    aria-label={c.pinned ? t.history.unpin : t.history.pin}
                    aria-pressed={c.pinned}
                    // Always rendered rather than revealed on hover: hover doesn't exist on a phone, and
                    // this list is mostly used on one.
                    className={`shrink-0 rounded-md p-1.5 transition ${
                      c.pinned
                        ? "text-blue-600 hover:bg-black/5 dark:text-blue-400 dark:hover:bg-white/10"
                        : "text-black/25 hover:bg-black/5 hover:text-black/60 dark:text-white/25 dark:hover:bg-white/10 dark:hover:text-white/60"
                    }`}
                  >
                    {c.pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
