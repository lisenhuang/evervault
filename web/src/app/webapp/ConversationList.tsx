"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Sparkles, X } from "lucide-react";
import { useT } from "@/i18n/LanguageProvider";
import { groupConversations, type BucketId } from "./lib/historyGroups";
import ConversationMenu from "./ConversationMenu";
import Pressable from "./Pressable";
import { decideRenameOutcome } from "./lib/renameOutcome";
import type { Conversation } from "./conversationsApi";

/**
 * The chat history in the sidebar: past conversations under Pinned / Today / Yesterday / …, each one a
 * button that reopens it.
 *
 * Presentational on purpose — it fetches nothing and owns no data. The sidebar renders its body TWICE
 * (a persistent rail on desktop, a slide-in overlay on mobile), so anything that loaded here would load
 * twice and anything remembered here would exist as two disagreeing copies. Chat.tsx owns the list.
 *
 * Renaming and pinning are on a context menu (right-click, or long-press on touch) rather than buttons
 * on each row: a title is the only thing in a sidebar row anyone reads, and two permanent controls beside
 * it left roughly half the width for the words. Pinned chats are already identified by the section they
 * sit in, so nothing is lost by taking the icons off the row.
 */
export default function ConversationList({
  conversations,
  activeId,
  loading,
  onOpen,
  onTogglePin,
  onRename,
  onRegenerateTitle,
}: {
  conversations: Conversation[];
  /** The conversation currently on screen, highlighted. Null while a brand-new chat is still empty. */
  activeId: string | null;
  loading: boolean;
  onOpen: (conversationId: string) => void;
  onTogglePin: (conversationId: string, pinned: boolean) => void;
  /** Rename. An empty name means "forget it" — the row goes back to its opening words. */
  onRename: (conversationId: string, title: string) => void;
  /** Ask the AI to name this conversation from the whole of it. Resolves to "" if it can't. */
  onRegenerateTitle: (conversationId: string) => Promise<string>;
}) {
  const t = useT();
  const groups = groupConversations(conversations);
  // The conversation being renamed, and the text so far. One at a time — this is a sidebar, not a form.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** The conversation a name is being generated for, so the spinner sits on the right row. */
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** Which conversation the editor is on, readable from async code that would otherwise close over a
   *  stale value. Kept in step with `editingId` by {@link setEditing}. */
  const editingIdRef = useRef<string | null>(null);
  /**
   * The conversation a re-generate was asked for, while it is still in flight.
   *
   * A ref because the answer arrives long after the tap, and what happened in between decides what to do
   * with it. Cleared when the user gives their own final word — Save, Cancel, Escape — and NOT by the
   * input losing focus, which on a phone is just the keyboard getting out of the way.
   */
  const pendingRegen = useRef<string | null>(null);
  // Which conversation the context menu belongs to, and where it was opened.
  const [menu, setMenu] = useState<{ c: Conversation; x: number; y: number } | null>(null);

  // Select the existing name on open, so replacing it outright is one keystroke and refining it is still
  // possible. The mobile sidebar animates in with a transform, so focus is deferred a frame.
  useEffect(() => {
    if (!editingId) return;
    const h = requestAnimationFrame(() => inputRef.current?.select());
    return () => cancelAnimationFrame(h);
  }, [editingId]);

  /** Move the editor, keeping the ref the async paths read in step with the state the UI renders from. */
  function setEditing(conversationId: string | null) {
    editingIdRef.current = conversationId;
    setEditingId(conversationId);
  }

  function startRename(conversationId: string, current: string) {
    setEditing(conversationId);
    setDraft(current);
  }

  /** Save what is in the box and close. */
  function commitRename() {
    const id = editingIdRef.current;
    if (id) {
      // An explicit save is the user's final word, so a name still being generated for this chat is
      // dropped rather than allowed to land on top of the one they just chose.
      if (pendingRegen.current === id) pendingRegen.current = null;
      onRename(id, draft);
    }
    setEditing(null);
  }

  /** Close without saving. Also abandons a re-generate in flight — the user said no to this rename. */
  function cancelRename() {
    pendingRegen.current = null;
    setEditing(null);
  }

  /**
   * The input losing focus. Normally that means "finished" — on a phone, dismissing the keyboard IS how
   * you finish — but not when it was the re-generate button that took the focus away.
   *
   * Tapping that button on a touch screen dismisses the keyboard and blurs the input, and preventDefault
   * on pointerdown does not stop it there the way it does with a mouse. Committing on that blur closed
   * the editor before the name came back, and the name was then dropped for having nowhere to go — so
   * the button appeared to do nothing at all, on phones only.
   */
  function handleBlur() {
    if (pendingRegen.current) return;
    commitRename();
  }

  /**
   * Ask the AI to name this conversation from the whole of it.
   *
   * Where the answer goes depends on where the user still is when it arrives. With a keyboard and mouse
   * the box keeps focus, so the name lands in it as a suggestion to accept or edit. On a phone the
   * keyboard has gone and the box is no longer where the user is looking, so the name is simply applied —
   * they asked for it, and making them find the tick afterwards is not a confirmation, it is a chore.
   */
  async function regenerate(conversationId: string) {
    // Guarded on the ref, not the state: a double tap re-enters this before a re-render could have
    // reported the first one.
    if (pendingRegen.current) return;
    pendingRegen.current = conversationId;
    setRegeneratingId(conversationId);

    let title = "";
    // Whether this request is still the one the user is waiting for. Saving or cancelling in the
    // meantime clears the flag, and that is the user telling us they have moved on.
    let stillWanted = false;
    try {
      title = await onRegenerateTitle(conversationId);
    } finally {
      // Always released, even if the call blew up: a stuck flag would suppress the blur-commit for the
      // rest of the session, leaving the editor unable to close by tapping away.
      stillWanted = pendingRegen.current === conversationId;
      if (stillWanted) pendingRegen.current = null;
      setRegeneratingId(null);
    }
    const editingThis = editingIdRef.current === conversationId;
    switch (
      decideRenameOutcome({
        title,
        stillWanted,
        editingThis,
        focused: typeof document !== "undefined" && document.activeElement === inputRef.current,
      })
    ) {
      case "discard":
        return;
      case "fill":
        setDraft(title);
        inputRef.current?.select();
        return;
      case "apply":
        // Left sitting in a box the user is no longer in, this would be work they asked for and then
        // have to rescue.
        onRename(conversationId, title);
        if (editingThis) setEditing(null);
        return;
    }
  }

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
              const label = c.title || t.history.untitled;
              if (c.conversationId === editingId) {
                return (
                  <li key={c.conversationId} className="flex items-center gap-0.5">
                    <input
                      ref={inputRef}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      // Blur commits as well as Enter: on a phone, dismissing the keyboard IS how you
                      // finish, and losing the rename to that would be its own small betrayal.
                      onBlur={handleBlur}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        else if (e.key === "Escape") cancelRename();
                      }}
                      maxLength={200}
                      aria-label={t.history.rename}
                      className="min-w-0 flex-1 rounded-lg border border-blue-500 bg-transparent px-3 py-2 text-sm outline-none"
                    />
                    {/* Pointer-down, not click: the input's blur fires first and would commit before a
                        click on any of these ever landed. */}
                    <button
                      onPointerDown={(e) => {
                        e.preventDefault();
                        void regenerate(c.conversationId);
                      }}
                      disabled={regeneratingId === c.conversationId}
                      title={t.history.regenerateTitle}
                      aria-label={t.history.regenerateTitle}
                      className="shrink-0 rounded-md p-1.5 text-black/40 transition hover:bg-black/5 hover:text-blue-600 disabled:opacity-60 dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-blue-400"
                    >
                      {regeneratingId === c.conversationId ? (
                        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                      ) : (
                        <Sparkles size={14} aria-hidden="true" />
                      )}
                    </button>
                    <button
                      onPointerDown={(e) => {
                        e.preventDefault();
                        cancelRename();
                      }}
                      title={t.common.cancel}
                      aria-label={t.common.cancel}
                      className="shrink-0 rounded-md p-1.5 text-black/40 transition hover:bg-black/5 dark:text-white/40 dark:hover:bg-white/10"
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                    <button
                      onPointerDown={(e) => {
                        e.preventDefault();
                        commitRename();
                      }}
                      title={t.history.renameSave}
                      aria-label={t.history.renameSave}
                      className="shrink-0 rounded-md p-1.5 text-blue-600 transition hover:bg-black/5 dark:text-blue-400 dark:hover:bg-white/10"
                    >
                      <Check size={14} aria-hidden="true" />
                    </button>
                  </li>
                );
              }
              return (
                <li key={c.conversationId}>
                  {/* -webkit-touch-callout / select-none keep a long press from turning into iOS's own
                      text-selection callout instead of our menu. */}
                  <Pressable
                    onOpen={(x, y) => setMenu({ c, x, y })}
                    className="[-webkit-touch-callout:none] [@media(hover:none)]:select-none"
                  >
                    <button
                      onClick={() => onOpen(c.conversationId)}
                      // aria-current, not just a background: which chat you are in is information, and a
                      // screen reader gets nothing from a tint.
                      aria-current={active ? "true" : undefined}
                      className={`w-full min-w-0 truncate rounded-lg px-3 py-2 text-left text-sm transition ${
                        active
                          ? "bg-black/5 font-medium text-black/80 dark:bg-white/10 dark:text-white/80"
                          : "text-black/70 hover:bg-black/5 dark:text-white/70 dark:hover:bg-white/10"
                      }`}
                    >
                      {/* A conversation opened with something that left no text — a photo with no caption —
                          has no words to be titled after, so it borrows the label a new chat starts with. */}
                      {label}
                    </button>
                  </Pressable>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {menu && (
        <ConversationMenu
          title={menu.c.title || t.history.untitled}
          pinned={menu.c.pinned}
          x={menu.x}
          y={menu.y}
          onRename={() => {
            startRename(menu.c.conversationId, menu.c.title || "");
            setMenu(null);
          }}
          onTogglePin={() => {
            onTogglePin(menu.c.conversationId, !menu.c.pinned);
            setMenu(null);
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
