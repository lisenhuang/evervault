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
