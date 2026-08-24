// The verbatim conversation record: every message the user sends and every message the assistant sends
// back, stored as text on the server. Voice messages and realtime calls are recorded from their
// transcripts — the browser is the only place those exist, since a Live call streams straight to Google
// and never passes through our backend.
//
// Separate from recordApi.ts on purpose. That writes the *recall* corpus (clipped, embedded, summarized,
// and removable one item at a time through the forget flow). This writes the *record*: full text, every
// message including replies that errored. Both are written; neither waits on the other.
//
// The record is what a reopened or refreshed conversation is rebuilt from, so deleting a message is a
// write too — see deleteTranscriptMessage. Without it, removing a bubble only clears the screen.
//
// Every write carries the browser's own message id, and the server treats it as an idempotency key. That
// is what makes the outbox below safe: a failed send is simply retried, and a reply re-sent after it grew
// while streaming updates its row instead of appending a second copy.

import { api } from "./authApi";

export type TranscriptItem = {
  /** The chat message's own id — the server's idempotency key. */
  clientMessageId: string;
  role: "user" | "assistant";
  modality: "text" | "voice" | "live" | "image";
  text: string;
  /** When the message was actually said, which for a reply is well before we finish recording it. */
  clientCreatedAt?: string;
};

/** A queued message, plus the conversation it belongs to (sends are grouped by conversation) and how
 *  many times sending it has failed — see MAX_ATTEMPTS. */
type Queued = TranscriptItem & { conversationId: string; attempts?: number };

// The queue is stored per account. localStorage is per-browser but these are one user's private
// messages, and the server stamps the row from the session cookie rather than the payload — so a queue
// flushed under a different identity would write one person's words into another person's account.
// Namespacing by email makes that impossible, and lets a user's own unsent messages survive until they
// next sign in rather than being thrown away. See the same hazard handled for the error-report queue
// (lib/errorReport.ts) and the style cache (lib/store.ts).
const OUTBOX_PREFIX = "ev:transcriptOutbox:";

// The other half of the record: messages the user has DELETED from the chat and that the server has not
// erased yet. Queued and persisted exactly like the outbox above, per account and for the same reasons —
// a delete has to survive being offline, the tab closing, and a deploy. Without it, deleting a bubble
// only clears the screen and the message is handed straight back by the next refresh.
const DELETIONS_PREFIX = "ev:transcriptDeletions:";
const MAX_DELETIONS = 500;

// A send that fails (offline, tab frozen mid-flight) is kept and retried on the next flush. The cap
// stops an outage from growing localStorage without bound; oldest entries go first, since the newest
// messages are the ones the user is most likely to still be looking at.
const MAX_OUTBOX = 200;

// The server's per-request cap, and the body size past which `keepalive` stops being allowed. A
// keepalive request over the browser's ~64KB quota is REJECTED outright rather than downgraded (the
// same trap authApi.ts documents), so the budget is measured in encoded bytes, never in characters.
const MAX_BATCH_ITEMS = 200;
const MAX_KEEPALIVE_BYTES = 50_000;

// Sending is retried indefinitely for the ordinary reasons (offline, an expired cookie, a deploy in
// progress), but a message the server keeps failing on would otherwise sit at the head of the queue and
// block every message behind it forever. After this many failed passes it is given up on, so one bad
// message costs one message rather than the whole record.
const MAX_ATTEMPTS = 12;

/** Messages not yet confirmed by the server, keyed by message id so a revision of a message still
 *  queued simply replaces it. Insertion order is send order. */
const outbox = new Map<string, Queued>();
/** Ids the user has deleted, mapped to how many times the server has answered and refused to erase them.
 *  Consulted by the sending path too: an id in here is never written, whatever is queued for it. */
const deletions = new Map<string, number>();
/** The signed-in account these messages belong to. Empty means "nobody" — nothing sends. */
let owner = "";
let loaded = false;
let flushing = false;
let deleting = false;
/** Bumped on every account change. A flush belongs to the generation it started in; if that number has
 *  moved by the time an await resolves, the batches it is still holding belong to a previous account and
 *  must not be sent under the new cookie, nor allowed to write over the new account's queue. Comparing
 *  the email alone wouldn't do: signing out and back in as the same person still resets the module. */
let generation = 0;

/**
 * Point the outbox at the signed-in account, dropping any in-memory state belonging to the previous one.
 * Must run before the chat mounts. The previous account's queue stays on disk under its own key, so it
 * still lands if that user signs back in — it simply can never be flushed as somebody else.
 */
export function setTranscriptOutboxOwner(email: string): void {
  if (email === owner) return;
  outbox.clear();
  deletions.clear();
  loaded = false;
  owner = email;
  generation++;
}

/**
 * Erase the signed-in account's queue outright. For account deletion only: the server has just wiped
 * this user's record, so unsent messages of theirs must not survive on disk — "everything is erased"
 * has to include what never made it off the device.
 *
 * Sign-out deliberately does NOT call this. Nothing needs it: the queue is namespaced per account and
 * the next sign-in re-points the module at its own key, so another user can never flush it — while
 * wiping here would throw away the tail of the conversation the user just had.
 */
export function purgeTranscriptOutbox(): void {
  if (owner) {
    try {
      localStorage.removeItem(OUTBOX_PREFIX + owner);
      localStorage.removeItem(DELETIONS_PREFIX + owner);
    } catch {
      /* storage disabled — nothing was persisted to remove */
    }
  }
  outbox.clear();
  deletions.clear();
  loaded = false;
  owner = "";
  generation++;
}

function load(): void {
  if (loaded || !owner) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(OUTBOX_PREFIX + owner);
    if (raw) {
      const rows = JSON.parse(raw) as Queued[];
      for (const r of rows) if (r?.clientMessageId) outbox.set(r.clientMessageId, r);
    }
  } catch {
    /* unreadable outbox — start clean rather than block recording */
  }
  try {
    const raw = localStorage.getItem(DELETIONS_PREFIX + owner);
    if (raw) {
      const rows = JSON.parse(raw) as [string, number][];
      for (const [id, attempts] of rows) if (id) deletions.set(id, typeof attempts === "number" ? attempts : 0);
    }
  } catch {
    /* unreadable — a delete that can't be replayed is no worse than one that was never queued */
  }
}

function persist(): void {
  if (!owner) return;
  try {
    const key = OUTBOX_PREFIX + owner;
    if (outbox.size === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify([...outbox.values()]));
  } catch {
    /* storage full / disabled — the in-memory queue still flushes this session */
  }
}

function persistDeletions(): void {
  if (!owner) return;
  try {
    const key = DELETIONS_PREFIX + owner;
    if (deletions.size === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify([...deletions]));
  } catch {
    /* storage full / disabled — the in-memory queue still flushes this session */
  }
}

/** Queue messages for recording and start a flush. Fire-and-forget: recording must never delay or
 *  interfere with the chat, so nothing here throws and nothing is awaited by the caller. */
export function recordTranscript(conversationId: string, items: TranscriptItem[]): void {
  if (!owner || !conversationId || items.length === 0) return;
  load();
  for (const it of items) {
    if (!it.clientMessageId || !it.text.trim()) continue;
    // Deleted by the user while it was still on its way to the server. Re-queueing it here is how a
    // message comes back from the dead: the erase would land and this write would put it straight back.
    if (deletions.has(it.clientMessageId)) continue;
    // Re-inserting under the same key keeps the newest wording and its original queue position.
    outbox.set(it.clientMessageId, { ...it, conversationId });
  }
  while (outbox.size > MAX_OUTBOX) outbox.delete(outbox.keys().next().value as string);
  persist();
  void flushTranscript();
}

/**
 * Erase one message from the record, and stop it ever being written if it hasn't been yet.
 *
 * Called when the user deletes a bubble. Deleting it on screen is not enough on its own: the recorder
 * writes every message that passes through the chat to the server, and a reopened or refreshed
 * conversation is rebuilt from exactly those rows — so a message removed only locally is handed back
 * intact the next time the page loads.
 *
 * Fire-and-forget, like recording, and queued for the same reasons: a delete made offline, or as the tab
 * closes, still has to land. Until the server confirms it, the id also acts as a tombstone that blocks
 * any write of that message — see recordTranscript and flushTranscript.
 */
export function deleteTranscriptMessage(clientMessageId: string): void {
  if (!owner || !clientMessageId) return;
  load();
  // Anything still queued for this message is moot — it is not going to be recorded at all.
  outbox.delete(clientMessageId);
  persist();
  deletions.set(clientMessageId, 0);
  // Oldest first, same as the outbox: a delete this far back has had many chances to send already.
  while (deletions.size > MAX_DELETIONS) deletions.delete(deletions.keys().next().value as string);
  persistDeletions();
  void flushTranscriptDeletions();
}

/**
 * Send every queued erase. One request per message: deletes are rare (a user removing a bubble), so
 * there is nothing to batch, and one failing must not hold up the rest.
 *
 * A server that answers anything other than success is counted against the message, exactly as a refused
 * write is — which is also what retires an erase aimed at a server that predates the endpoint (404) once
 * it has been tried enough times. Being offline costs nothing: the queue simply waits for the next flush.
 */
export async function flushTranscriptDeletions(): Promise<void> {
  load();
  if (deleting || !owner || deletions.size === 0) return;
  deleting = true;
  const gen = generation;
  // Ids this pass has already sent a request for. Deleting a second bubble while the first erase is in
  // flight lands here mid-run (and its own call is turned away by the guard above), so the queue is
  // re-read each time round rather than iterated over a snapshot — while this set stops a message that
  // just failed from being retried immediately and burning its whole attempt budget in one flush.
  const tried = new Set<string>();
  try {
    for (;;) {
      if (generation !== gen) return; // account changed — these erases belong to somebody else's cookie
      const id = [...deletions.keys()].find((k) => !tried.has(k));
      if (id === undefined) return;
      tried.add(id);
      let ok = false;
      let answered = false;
      try {
        const res = await api(`/api/chat/transcript/${encodeURIComponent(id)}`, {
          method: "DELETE",
          // No body, so it is always small enough — a delete made as the tab closes still goes out.
          keepalive: true,
        });
        answered = true;
        ok = res.ok;
      } catch {
        ok = false;
      }
      if (generation !== gen) return;
      if (ok) {
        deletions.delete(id);
        persistDeletions();
        continue;
      }
      // Offline: stop here rather than burning every message's attempts on one dead network.
      if (!answered) return;
      const attempts = (deletions.get(id) ?? 0) + 1;
      if (attempts >= MAX_ATTEMPTS) deletions.delete(id);
      else deletions.set(id, attempts);
      persistDeletions();
    }
  } finally {
    deleting = false;
  }
}

/** Whether a failed send is worth keeping. Only a request the server will never accept is dropped;
 *  everything else — an expired cookie, a 404 while a deploy rolls out, a rate limit, any 5xx — is a
 *  message we still owe the record, so it stays queued for the next flush. */
function isPermanentlyRejected(status: number): boolean {
  return status === 400 || status === 413 || status === 422;
}

/**
 * Called with a conversation id each time messages for it are accepted by the server.
 *
 * The history sidebar is built from recorded messages, so a brand-new chat only exists to it once one
 * has actually landed — which is not a fixed moment after the message appears on screen: the recorder
 * waits for the list to go quiet, and a reply that streams for six seconds, or is still being spoken,
 * keeps it waiting. Guessing a delay is how the new chat ends up missing from its own sidebar; this is
 * the event that actually happened.
 */
type RecordedListener = (conversationId: string) => void;
const recordedListeners = new Set<RecordedListener>();

/** Subscribe to "messages for this conversation are now on the server". Returns an unsubscribe. */
export function onTranscriptRecorded(fn: RecordedListener): () => void {
  recordedListeners.add(fn);
  return () => recordedListeners.delete(fn);
}

function announceRecorded(conversationId: string) {
  // A listener throwing must not abandon the rest of the flush — it is a UI refresh, not the record.
  for (const fn of recordedListeners) {
    try {
      fn(conversationId);
    } catch {
      /* ignore */
    }
  }
}

/** Send everything queued, grouped by conversation. Anything that fails stays queued for the next
 *  flush — which the recorder also triggers on mount, when connectivity returns, and as the tab closes. */
export async function flushTranscript(): Promise<void> {
  load();
  // Erases go first, and on every trigger this flush has (mount, reconnect, unload) — a message the user
  // deleted should leave the server at the first opportunity, not wait for the next one they send.
  await flushTranscriptDeletions();
  if (flushing || !owner || outbox.size === 0) return;
  flushing = true;
  // Set when a batch that has just been written turns out to contain a message deleted while it was in
  // flight: the erase raced the write and lost, so the row is back and has to be erased again.
  let raced = false;
  // The account this flush belongs to. A sign-out or account switch can land on any await below, and
  // from that moment these messages are somebody else's business: the cookie now belongs to another
  // user (so the server would file them under them) and `outbox`/the storage key have been re-pointed
  // (so deleting or persisting would corrupt the new account's queue). Every await re-checks it.
  const gen = generation;
  try {
    // Bounded re-loop so a message queued *during* a flush isn't parked until some unrelated later
    // trigger — the same shape as flushErrorReports.
    for (let pass = 0; pass < 5; pass++) {
      if (outbox.size === 0 || generation !== gen) return;

      const byConversation = new Map<string, Queued[]>();
      for (const q of outbox.values()) {
        const group = byConversation.get(q.conversationId);
        if (group) group.push(q);
        else byConversation.set(q.conversationId, [q]);
      }

      let stalled = false;
      for (const [conversationId, queued] of byConversation) {
        let i = 0;
        while (i < queued.length) {
          // Greedily fill a batch, always taking at least one message so an oversized one can't wedge
          // the queue behind a batch that never fits. Three bytes per code unit is the worst case for
          // the scripts this app ships in, so the estimate can only over-reserve.
          const batch: Queued[] = [];
          let bytes = 0;
          while (i < queued.length && batch.length < MAX_BATCH_ITEMS) {
            const size = queued[i].text.length * 3 + 300;
            if (batch.length > 0 && bytes + size > MAX_KEEPALIVE_BYTES) break;
            batch.push(queued[i]);
            bytes += size;
            i++;
          }

          const messages: TranscriptItem[] = batch.map((q) => ({
            clientMessageId: q.clientMessageId,
            role: q.role,
            modality: q.modality,
            text: q.text,
            clientCreatedAt: q.clientCreatedAt,
          }));
          const body = JSON.stringify({ conversationId, messages });
          let ok = false;
          // Whether the server actually answered. Only a real answer counts against MAX_ATTEMPTS: being
          // offline must never burn a message's retries, and a flush fires on every recorded message,
          // so an outage would otherwise exhaust them in seconds.
          let answered = false;
          try {
            const res = await api("/api/chat/transcript", {
              method: "POST",
              body,
              ...(new Blob([body]).size <= MAX_KEEPALIVE_BYTES ? { keepalive: true } : {}),
            });
            answered = true;
            ok = res.ok || isPermanentlyRejected(res.status);
          } catch {
            ok = false;
          }
          // The account may have changed while that request was in flight; if it has, this queue is no
          // longer ours to modify and the messages stay put under their own owner's key. Placed before
          // the delete, before persist(), and before the next batch is sent.
          if (generation !== gen) return;

          if (!ok) {
            if (answered) {
              // The server answered and refused. Count it against each message and give up on any that
              // has been refused too often, so it can't block the queue behind it forever.
              for (const q of batch) {
                if (outbox.get(q.clientMessageId) !== q) continue; // revised mid-flight; leave the new one
                const attempts = (q.attempts ?? 0) + 1;
                if (attempts >= MAX_ATTEMPTS) outbox.delete(q.clientMessageId);
                else outbox.set(q.clientMessageId, { ...q, attempts });
              }
              persist();
            }
            stalled = true;
            break;
          }
          if (batch.some((q) => deletions.has(q.clientMessageId))) raced = true;
          // Drop by identity, not by key: a revision queued while this batch was in flight is a
          // different object under the same id, and deleting it would lose the newer wording.
          for (const q of batch) if (outbox.get(q.clientMessageId) === q) outbox.delete(q.clientMessageId);
          persist();
          announceRecorded(conversationId);
        }
        if (stalled) break;
      }
      if (stalled) return;
    }
  } finally {
    flushing = false;
    if (raced) void flushTranscriptDeletions();
  }
}

export type TranscriptMessage = {
  id: number;
  conversationId: string;
  clientMessageId: string;
  role: "user" | "assistant";
  modality: string;
  content: string;
  clientCreatedAt: string | null;
  createdAt: string;
  /** The stored message is longer than a listing returns — `content` here is the opening of it. */
  truncated: boolean;
};

/** Read the record back — oldest-first within a conversation, newest-first without one. */
export async function fetchTranscript(
  conversationId?: string,
  opts?: { skip?: number; take?: number },
): Promise<TranscriptMessage[]> {
  const params = new URLSearchParams();
  if (conversationId) params.set("conversationId", conversationId);
  if (opts?.skip) params.set("skip", String(opts.skip));
  if (opts?.take) params.set("take", String(opts.take));
  try {
    const res = await api(`/api/chat/transcript?${params}`);
    if (res.ok) return (await res.json()) as TranscriptMessage[];
  } catch {
    /* ignore */
  }
  return [];
}
