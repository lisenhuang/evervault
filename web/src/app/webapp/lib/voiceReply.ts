// Server-side spoken-reply audio for the /webapp voice messages.
//
// A voice reply's audio used to be synthesized in the browser (TTS via the Gemini proxy) AFTER the text
// reply streamed in. On iOS Safari, switching away from the tab suspends the page and kills that in-flight
// request — so a user who fired a voice message and left came back to the reply text with no voice. These
// helpers hand the finished reply text to the backend, which synthesizes the audio on a worker that keeps
// running regardless of the tab's state; the client then polls for the clip (immediately, and again on
// every return to the foreground). See ChatAiController's voice-reply endpoints.

import { api } from "../authApi";

export type VoiceReplyAudio = { base64: string; sampleRate: number };

/** One poll of a reply's synthesis: ready (carries the PCM), still working, given up, or unheard-of. */
export type VoiceReplyPoll =
  | { status: "ready"; base64: string; sampleRate: number }
  | { status: "pending" | "failed" | "unknown" };

/**
 * Ask the backend to synthesize `text` as the spoken audio for the reply identified by `replyId` (the
 * assistant message id) in the given `voice`. Returns true when the backend accepted the job, false when
 * the request failed — an older backend without this endpoint (404), a server error, or a network drop —
 * so the caller can fall back to in-browser TTS. Idempotent server-side: safe to call repeatedly for the
 * same replyId (a re-post just reads back the current status).
 */
export async function startVoiceReply(replyId: string, text: string, voice: string): Promise<boolean> {
  try {
    const res = await api("/api/chat/ai/voice-reply", {
      method: "POST",
      body: JSON.stringify({ replyId, text, voice }),
    });
    return res.ok; // 2xx incl. 202 Accepted
  } catch {
    return false;
  }
}

/** Poll one reply's synthesis. Network/parse failures degrade to "pending" so the caller keeps waiting. */
export async function fetchVoiceReply(replyId: string): Promise<VoiceReplyPoll> {
  try {
    const res = await api(`/api/chat/ai/voice-reply/${encodeURIComponent(replyId)}`);
    if (res.status === 404) return { status: "unknown" };
    if (!res.ok) return { status: "pending" };
    return (await res.json()) as VoiceReplyPoll;
  } catch {
    return { status: "pending" };
  }
}

// --- Sentence-chunked spoken replies (admin opt-in) ---
//
// When the admin turns on chunked voice replies, the backend synthesizes the reply sentence-by-sentence and
// exposes the chunks as they land, so the browser can start playing the first sentence while the rest is
// still being generated. Two transports read the SAME server-side job: an SSE stream (the fast path — the
// server pushes each chunk the instant it's ready) and an incremental poll (the fallback — used when SSE
// isn't available, errors, or a backgrounded tab drops the connection and we catch up on return). Both are
// contiguous and ordered, so a cursor (`from` = next chunk index wanted) dedupes across the two.

/** One synthesized chunk: its position in the reply, base64 mono PCM16, and the sample rate. */
export type VoiceReplyChunk = { index: number; base64: string; sampleRate: number };

/** One incremental poll of a chunked reply. "pending" covers a transient network/parse hiccup (keep
 *  waiting); "unknown" means the job was never started or was swept (the caller re-kicks). */
export type VoiceReplyChunkPoll =
  | { status: "ok"; chunks: VoiceReplyChunk[]; totalReady: number; ended: boolean }
  | { status: "pending" | "unknown" };

/** Incrementally poll a chunked reply for any chunks at or past `from`. Fallback for {@link openVoiceReplyStream}. */
export async function fetchVoiceReplyChunks(replyId: string, from: number): Promise<VoiceReplyChunkPoll> {
  try {
    const res = await api(`/api/chat/ai/voice-reply/${encodeURIComponent(replyId)}/chunks?from=${from}`);
    if (res.status === 404) return { status: "unknown" };
    if (!res.ok) return { status: "pending" };
    const d = (await res.json()) as {
      chunks: { index: number; base64: string }[];
      totalReady: number;
      sampleRate: number;
      ended: boolean;
    };
    return {
      status: "ok",
      chunks: (d.chunks ?? []).map((c) => ({ index: c.index, base64: c.base64, sampleRate: d.sampleRate })),
      totalReady: d.totalReady ?? 0,
      ended: !!d.ended,
    };
  } catch {
    return { status: "pending" };
  }
}

/**
 * Open the SSE stream for a chunked reply, starting at chunk index `from`. Calls `onChunk` for each chunk as
 * it's pushed, then exactly one terminal callback: `onDone` when every chunk has been delivered, or `onError`
 * on any failure (network drop, backgrounded tab, unknown/swept reply, or SSE unsupported). Returns a
 * disposer that closes the stream; the caller falls back to {@link fetchVoiceReplyChunks} after `onError`.
 * Same-origin, so the EventSource carries the ev_user session cookie automatically.
 */
export function openVoiceReplyStream(
  replyId: string,
  from: number,
  handlers: { onChunk: (c: VoiceReplyChunk) => void; onDone: () => void; onError: () => void },
): () => void {
  // No EventSource (very old/SSR) → signal error so the caller uses the poll fallback.
  if (typeof EventSource === "undefined") {
    handlers.onError();
    return () => {};
  }
  let closed = false;
  const url = `/api/chat/ai/voice-reply/${encodeURIComponent(replyId)}/stream?from=${from}`;
  const es = new EventSource(url, { withCredentials: true });
  const close = () => {
    if (closed) return;
    closed = true;
    es.close();
  };
  es.onmessage = (e) => {
    let d: { type?: string; index?: number; base64?: string; sampleRate?: number };
    try {
      d = JSON.parse(e.data);
    } catch {
      return; // ignore a malformed frame; the stream continues
    }
    if (d.type === "chunk" && typeof d.index === "number" && typeof d.base64 === "string") {
      handlers.onChunk({ index: d.index, base64: d.base64, sampleRate: d.sampleRate ?? 24000 });
    } else if (d.type === "done") {
      close();
      handlers.onDone();
    } else if (d.type === "error") {
      close();
      handlers.onError();
    }
  };
  es.onerror = () => {
    // The browser fires onerror on a network drop, a backgrounded-tab suspension, or the server closing the
    // stream (incl. its ~90s bound) without a terminal frame. EventSource would otherwise auto-reconnect, so
    // close it and hand off to the poll fallback, which resumes from the caller's cursor.
    close();
    handlers.onError();
  };
  return close;
}
