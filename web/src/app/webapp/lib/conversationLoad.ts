// Reads one past conversation back out of the durable record and turns it into chat bubbles.
//
// What comes back is text and only text. The record stores what was SAID — role, modality, content — and
// nothing about how it looked: attachments, reply quotes, spoken audio and the "call ended" chips were
// never in it (see transcriptRecorder.ts). So a reopened conversation reads as the conversation, which is
// the point, and does not restore as the screen it used to be. The parts that can be recovered are.
//
// The message ids are the record's own. That is not cosmetic: the server treats a client message id as
// its idempotency key, unique per USER, so a bubble that came back under a fresh id would be written as a
// second copy of a message that already exists rather than recognised as the same one.

import { fetchTranscript, type TranscriptMessage } from "../transcriptApi";
import type { ChatMessage } from "../types";

/** Rows per request. The server clamps take to 200, so asking for more just gets 200. */
const PAGE = 200;
/** Ceiling on how much of a very long conversation is put back on screen. Reopening is for continuing a
 *  thread, not for auditing one — the oldest messages beyond this stay in the record, and the model gets
 *  its own bounded tail of the conversation anyway. */
const MAX_MESSAGES = 600;

export type LoadedConversation = {
  messages: ChatMessage[];
  /** The stored rows behind those messages, in the same order — what the recorder needs to adopt them. */
  rows: TranscriptMessage[];
  /** True when the ceiling cut the conversation short, so the oldest part isn't shown. */
  clipped: boolean;
};

/** A recorded modality back into the bubble kind that renders it. "live" and "text" both read as plain
 *  text: a call's turns were speech, but there is no audio left to attach to them. */
function kindOf(modality: string): ChatMessage["kind"] {
  if (modality === "voice") return "voice";
  if (modality === "image") return "image";
  return undefined;
}

export function toChatMessage(row: TranscriptMessage): ChatMessage {
  return {
    id: row.clientMessageId,
    role: row.role,
    text: row.content,
    kind: kindOf(row.modality),
  };
}

/**
 * Everything said in one conversation, oldest first. Never throws: a failed page ends the read and
 * returns what arrived, because half a conversation on screen beats an error where a chat should be.
 */
export async function loadConversation(conversationId: string): Promise<LoadedConversation> {
  const rows: TranscriptMessage[] = [];
  for (let skip = 0; skip < MAX_MESSAGES; skip += PAGE) {
    const page = await fetchTranscript(conversationId, { skip, take: Math.min(PAGE, MAX_MESSAGES - skip) });
    rows.push(...page);
    // A short page is the end of the conversation; an empty one is also how a failed request looks, and
    // stopping is the right answer to both.
    if (page.length < PAGE) return { messages: rows.map(toChatMessage), rows, clipped: false };
  }
  return { messages: rows.map(toChatMessage), rows, clipped: true };
}
