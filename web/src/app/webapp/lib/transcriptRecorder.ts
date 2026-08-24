// Records every message in the chat — both sides, every surface — into the durable conversation record
// (see transcriptApi.ts). Text messages, voice messages and realtime calls all land here as text.
//
// It watches the message list rather than the send/reply lifecycle, and that is the whole point. Turn
// bookkeeping is where messages go missing: a user message recorded only once its reply succeeds is lost
// when the reply fails, an error bubble is a real thing the assistant said but belongs to no successful
// turn, and a call that drops mid-sentence never reaches its end-of-turn hook. Every one of those still
// passes through applyMessages, so watching the list catches them all by construction — and catches
// whatever surface gets added next without anyone having to remember to wire it up.
//
// Messages are keyed by their own client id, which the server treats as an idempotency key, so recording
// the same message twice (a retry, a reply re-sent once it finished streaming, a flush as the tab closes)
// updates one row instead of appending copies.

import { useCallback, useEffect, useMemo, useRef } from "react";
import { flushTranscript, recordTranscript, type TranscriptItem } from "../transcriptApi";
import { messageBodyText, type ChatMessage } from "../types";

/** Quiet period before a settled message is recorded. Reset by every change to the list, so a streaming
 *  reply or a live call being spoken into records once it pauses rather than on every delta. */
const SETTLE_MS = 1500;

type Entry = {
  conversationId: string;
  role: "user" | "assistant";
  modality: TranscriptItem["modality"];
  text: string;
  streaming: boolean;
  /** When the message first appeared — much closer to when it was actually said than record time. */
  at: string;
  /** The text last handed to the recorder, so only a genuine revision is re-sent. */
  recorded: string | null;
};

function modalityOf(kind: ChatMessage["kind"], inCall: boolean): TranscriptItem["modality"] {
  if (inCall) return "live";
  if (kind === "voice") return "voice";
  if (kind === "image") return "image";
  return "text";
}

/** One message being handed back from the stored record, so the recorder knows it is already written. */
export type HydratedMessage = {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  modality: TranscriptItem["modality"];
  text: string;
  /** When it was originally said — the stored `clientCreatedAt`, never now. */
  at: string;
};

/** What the chat needs from the recorder beyond it simply running. */
export type TranscriptRecorder = {
  /** Adopt messages read back OUT of the record as already recorded — see the implementation. */
  hydrate: (loaded: HydratedMessage[]) => void;
  /** Stop tracking a message the user has DELETED, so it is not written back — see the implementation. */
  forget: (id: string) => void;
};

/**
 * @param messages   the current chat list (every mutation flows through applyMessages)
 * @param conversationId  the conversation a message appearing *now* belongs to
 * @param inCall     whether a realtime call is up, which is what makes a message "live"
 * @returns `hydrate` and `forget` — see below.
 */
export function useTranscriptRecorder(
  messages: ChatMessage[],
  conversationId: () => string,
  inCall: () => boolean,
): TranscriptRecorder {
  // Keyed by message id and kept independently of the list: a message deleted, or cleared by "New chat",
  // before its quiet period elapsed must still be recorded — it was said either way.
  const seen = useRef(new Map<string, Entry>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest-value refs so the effects below never depend on the caller memoizing these — an unstable
  // callback in the dep array would re-arm the debounce every render and could starve the sync.
  // Mirrored in an effect (not during render), and declared first so it commits before the one that reads it.
  const convIdRef = useRef(conversationId);
  const inCallRef = useRef(inCall);
  useEffect(() => {
    convIdRef.current = conversationId;
    inCallRef.current = inCall;
  });

  /** Hand every settled, changed message to the recorder. `includeStreaming` records half-finished
   *  replies too — used when the tab is going away and waiting is not an option. */
  const sync = useCallback((includeStreaming: boolean) => {
    const byConversation = new Map<string, TranscriptItem[]>();
    for (const [id, e] of seen.current) {
      if (e.streaming && !includeStreaming) continue;
      if (!e.text.trim() || e.text === e.recorded) continue;
      e.recorded = e.text;
      const item: TranscriptItem = {
        clientMessageId: id,
        role: e.role,
        modality: e.modality,
        text: e.text,
        clientCreatedAt: e.at,
      };
      const group = byConversation.get(e.conversationId);
      if (group) group.push(item);
      else byConversation.set(e.conversationId, [item]);
    }
    for (const [convId, items] of byConversation) recordTranscript(convId, items);
  }, []);

  useEffect(() => {
    const live = new Set<string>();
    for (const m of messages) {
      live.add(m.id);
      // The "call ended" chip is UI, not something either side said.
      if (m.kind === "call") continue;
      const existing = seen.current.get(m.id);
      if (existing) {
        seen.current.set(m.id, {
          ...existing,
          // messageBodyText, not m.text: a voice message sent with typed text keeps the typed half in
          // `caption`, and the stored transcript has to carry the whole message.
          text: messageBodyText(m),
          streaming: !!m.streaming,
          // A voice reply's kind can land after the bubble does; keep the latest classification.
          modality: existing.modality === "live" ? "live" : modalityOf(m.kind, false),
        });
      } else {
        seen.current.set(m.id, {
          conversationId: convIdRef.current(),
          role: m.role,
          modality: modalityOf(m.kind, inCallRef.current()),
          // messageBodyText, not m.text: a voice message sent with typed text keeps the typed half in
          // `caption`, and the stored transcript has to carry the whole message.
          text: messageBodyText(m),
          streaming: !!m.streaming,
          at: new Date().toISOString(),
          recorded: null,
        });
      }
    }
    // Once a message leaves the list — deleted, or cleared by "New chat" — nothing can revise it again.
    // A reply still marked streaming at that moment is therefore final as it stands, so drop the flag or
    // it would be skipped by every later settle and never recorded at all. Then forget it: when it has
    // been recorded, or when there is nothing recordable (an empty "typing" placeholder that never
    // produced text), so the map doesn't grow for the life of the session.
    for (const [id, e] of seen.current) {
      if (live.has(id)) continue;
      if (e.recorded === e.text || !e.text.trim()) seen.current.delete(id);
      else if (e.streaming) seen.current.set(id, { ...e, streaming: false });
    }

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => sync(false), SETTLE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [messages, sync]);

  // Leaving or backgrounding the tab: record whatever exists right now, streaming replies included, and
  // push the outbox out. iOS suspends a backgrounded tab outright, so this is the last chance to run.
  useEffect(() => {
    const onPageHide = () => {
      sync(true);
      void flushTranscript();
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") onPageHide();
    };
    const onOnline = () => void flushTranscript();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    // Connectivity coming back is the moment a queue that failed while offline can finally land.
    window.addEventListener("online", onOnline);
    // Anything left queued by a previous session (an offline send, a tab killed mid-flush) goes now.
    // Safe to fire here and nowhere earlier: this runs inside the signed-in chat, so the queue has
    // already been bound to the current account (see setTranscriptOutboxOwner in page.tsx).
    void flushTranscript();
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("online", onOnline);
      // Unmount is as much an end as a hide — a queued turn's reply shouldn't die with the component.
      sync(true);
      void flushTranscript();
    };
  }, [sync]);

  /**
   * Adopt messages that came back OUT of the record — reopening a past conversation — as already
   * recorded, so putting them on screen doesn't write them straight back.
   *
   * Without this the effect above meets them as brand-new (`recorded: null`) and posts the lot a second
   * and a half later. Mostly that would be a wasteful no-op the server discards as unchanged, but not
   * always: a listing clips each message to 32k, so any message longer than that comes back as its own
   * opening — and writing THAT back replaces the stored original with the clip, irreversibly. Seeding
   * `recorded` with the same text is what makes `sync` skip them (it only sends genuine revisions), and
   * it is why this must run before the messages are handed to applyMessages, not after.
   */
  const hydrate = useCallback((loaded: HydratedMessage[]) => {
    for (const m of loaded) {
      seen.current.set(m.id, {
        conversationId: m.conversationId,
        role: m.role,
        modality: m.modality,
        text: m.text,
        streaming: false,
        at: m.at,
        recorded: m.text,
      });
    }
  }, []);

  /**
   * Drop a message the user has DELETED, so the recorder never writes it.
   *
   * A message leaving the list normally means the opposite (see the effect above): it was still said, so
   * it is kept and recorded even though the bubble is gone — cleared by "New chat", or deleted before its
   * quiet period elapsed. A deliberate delete is the one case where that is wrong, and it is not
   * something the list can tell us: both look identical from here. So the chat says so explicitly, and
   * this is what stops the very next settle from writing the message the user just removed.
   *
   * Erasing what is ALREADY on the server is a separate step (deleteTranscriptMessage) — this only stops
   * the recorder putting it back.
   */
  const forget = useCallback((id: string) => {
    seen.current.delete(id);
  }, []);

  return useMemo(() => ({ hydrate, forget }), [hydrate, forget]);
}
