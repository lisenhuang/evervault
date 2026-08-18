// Reads one past conversation back out of the durable record and turns it into chat bubbles.
//
// The record stores what was SAID — role, modality, content — and nothing about how it looked: reply
// quotes, spoken audio and the "call ended" chips were never in it (see transcriptRecorder.ts). So a
// reopened conversation reads as the conversation, which is the point, and does not restore as the screen
// it used to be. The parts that can be recovered are.
//
// Attachments are one of those parts. They were never in the transcript either, but the files themselves
// were kept (ChatFiles) and know their conversation, so they are read alongside it and hung back on their
// messages — see conversationFiles.ts. Metadata only: a restored attachment loads its bytes when it is
// actually shown, not when the chat opens.
//
// The message ids are the record's own. That is not cosmetic: the server treats a client message id as
// its idempotency key, unique per USER, so a bubble that came back under a fresh id would be written as a
// second copy of a message that already exists rather than recognised as the same one.

import { fetchTranscript, type TranscriptMessage } from "../transcriptApi";
import type { ChatMessage } from "../types";
import { listConversationFiles } from "./filesApi";
import { attachConversationFiles } from "./conversationFiles";

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
    // What the browser said the time was, falling back to when we recorded it. For a reply those differ
    // by however long it streamed, so the client's own stamp is the truer answer.
    at: row.clientCreatedAt ?? row.createdAt,
  };
}

/**
 * Everything said in one conversation, oldest first. Never throws: a failed page ends the read and
 * returns what arrived, because half a conversation on screen beats an error where a chat should be.
 */
export async function loadConversation(conversationId: string): Promise<LoadedConversation> {
  // The text and the attachments are independent reads, so they go out together — the files listing is
  // small (metadata only, no bytes) and waiting for it in series would delay the whole conversation.
  const [rowsResult, files] = await Promise.all([
    readTranscript(conversationId),
    listConversationFiles(conversationId),
  ]);
  const { rows, clipped } = rowsResult;
  return { messages: attachConversationFiles(rows.map(toChatMessage), rows, files), rows, clipped };
}

/** Every recorded message in one conversation, oldest first, paged to the ceiling. */
async function readTranscript(conversationId: string): Promise<{ rows: TranscriptMessage[]; clipped: boolean }> {
  const rows: TranscriptMessage[] = [];
  for (let skip = 0; skip < MAX_MESSAGES; skip += PAGE) {
    const page = await fetchTranscript(conversationId, { skip, take: Math.min(PAGE, MAX_MESSAGES - skip) });
    rows.push(...page);
    // A short page is the end of the conversation; an empty one is also how a failed request looks, and
    // stopping is the right answer to both.
    if (page.length < PAGE) return { rows, clipped: false };
  }
  return { rows, clipped: true };
}
