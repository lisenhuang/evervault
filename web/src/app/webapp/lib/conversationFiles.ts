// Putting a reopened conversation's attachments back on the messages that carried them.
//
// The transcript record is text: it stores what was said, not what was sent alongside it. The files
// themselves have been kept all along (ChatFiles, permanently, in object storage) and every row knows
// which conversation it belonged to — so the pieces to rebuild a chat with its photos in it were already
// there, with nothing joining them.
//
// Files uploaded from now on carry the id of the message they were attached to, which makes that join
// exact. Files stored before that column existed have no such link, and those are precisely the ones in
// the history a user is reopening today — so they are matched by time instead, on the one fact the
// upload path guarantees: a file row is written after the message that carried it was sent, and before
// anything later was. That is a heuristic, and it is confined to this file and to rows that have no
// better answer.

import type { StoredFileMeta } from "./filesApi";
import { storedFileToPrepared } from "./filesApi";
import type { TranscriptMessage } from "../transcriptApi";
import type { ChatMessage } from "../types";

/** How far after a message a link-less file may still be considered part of it. Uploads are fired once
 *  the assistant's reply has finished, so the gap is normally seconds to a couple of minutes — a long
 *  spoken reply, a slow network and a queued retry all stretch it. Past this the pairing is a guess
 *  rather than an inference, and showing someone else's photo on a message is worse than showing none. */
const MAX_UPLOAD_LAG_MS = 30 * 60 * 1000;

/** When a message was said, preferring the browser's own timestamp over when the server recorded it —
 *  a reply is recorded when it finishes streaming, which can be long after it began. */
function timeOf(row: TranscriptMessage): number {
  const t = Date.parse(row.clientCreatedAt ?? row.createdAt);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Attach each stored file to the message it belongs to, returning a new message list.
 *
 * Exact links win outright. What is left over is walked oldest-first and given to the most recent user
 * message that was already sent when the file was stored — the message it was almost certainly attached
 * to. A message that already received an exactly-linked file is never added to by that guess: it has
 * told us what it carried, and appending to it would be inventing.
 *
 * Pure and total: unmatched files are dropped rather than shown somewhere arbitrary, and a message with
 * no files is returned untouched.
 */
export function attachConversationFiles(
  messages: ChatMessage[],
  rows: TranscriptMessage[],
  files: StoredFileMeta[],
): ChatMessage[] {
  if (files.length === 0) return messages;

  // Message id -> the files to hang on it.
  const byMessage = new Map<string, StoredFileMeta[]>();
  const add = (id: string, f: StoredFileMeta) => {
    const cur = byMessage.get(id);
    if (cur) cur.push(f);
    else byMessage.set(id, [f]);
  };

  const known = new Set(rows.map((r) => r.clientMessageId));
  const linked: StoredFileMeta[] = [];
  const unlinked: StoredFileMeta[] = [];
  for (const f of files) {
    // A link to a message that isn't in this conversation is not a link — it is a row pointing at
    // something we can't show, and guessing a home for it would be worse than leaving it out.
    if (f.clientMessageId && known.has(f.clientMessageId)) linked.push(f);
    else if (!f.clientMessageId) unlinked.push(f);
  }
  for (const f of linked) add(f.clientMessageId!, f);

  if (unlinked.length > 0) {
    // Only the user's own messages are candidates: an attachment is something the user sent, and the
    // assistant's turns are the recorded text of a reply.
    const candidates = rows
      .filter((r) => r.role === "user")
      .map((r) => ({ id: r.clientMessageId, at: timeOf(r) }))
      .sort((a, b) => a.at - b.at);

    if (candidates.length > 0) {
      for (const f of [...unlinked].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
        const at = Date.parse(f.createdAt);
        if (!Number.isFinite(at)) continue;
        // The last message already sent when this file was stored.
        let best: { id: string; at: number } | null = null;
        for (const c of candidates) {
          if (c.at <= at) best = c;
          else break;
        }
        if (!best || at - best.at > MAX_UPLOAD_LAG_MS) continue;
        // Never pile a guess onto a message that already told us exactly what it carried.
        if (linked.some((l) => l.clientMessageId === best!.id)) continue;
        add(best.id, f);
      }
    }
  }

  if (byMessage.size === 0) return messages;
  return messages.map((m) => {
    const files = byMessage.get(m.id);
    if (!files) return m;
    return {
      ...m,
      // A restored attachment carries no bytes — it points at the server and loads when shown.
      files: files.map(storedFileToPrepared),
      // `kind` is left exactly as it was: it decides the MODALITY this message is recorded under, not how
      // it renders, so rewriting it here would change what a later revision writes back to the record.
    };
  });
}
