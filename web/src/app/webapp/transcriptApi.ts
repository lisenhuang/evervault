// The verbatim conversation record: every message the user sends and every message the assistant sends
// back, stored as text on the server. Voice messages and realtime calls are recorded from their
// transcripts — the browser is the only place those exist, since a Live call streams straight to Google
// and never passes through our backend.
//
// Separate from recordApi.ts on purpose. That writes the *recall* corpus (clipped, embedded, summarized,
// and removable one item at a time through the forget flow). This writes the *record*: full text, every
// message including replies that errored, append-only. Both are written; neither waits on the other.
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
/** The signed-in account these messages belong to. Empty means "nobody" — nothing sends. */
let owner = "";
let loaded = false;
let flushing = false;
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
    } catch {
      /* storage disabled — nothing was persisted to remove */
    }
  }
  outbox.clear();
  loaded = false;
  owner = "";
  generation++;
}

function load(): void {
  if (loaded || !owner) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(OUTBOX_PREFIX + owner);
    if (!raw) return;
    const rows = JSON.parse(raw) as Queued[];
    for (const r of rows) if (r?.clientMessageId) outbox.set(r.clientMessageId, r);
  } catch {
    /* unreadable outbox — start clean rather than block recording */
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

/** Queue messages for recording and start a flush. Fire-and-forget: recording must never delay or
 *  interfere with the chat, so nothing here throws and nothing is awaited by the caller. */
export function recordTranscript(conversationId: string, items: TranscriptItem[]): void {
  if (!owner || !conversationId || items.length === 0) return;
  load();
  for (const it of items) {
    if (!it.clientMessageId || !it.text.trim()) continue;
    // Re-inserting under the same key keeps the newest wording and its original queue position.
    outbox.set(it.clientMessageId, { ...it, conversationId });
  }
  while (outbox.size > MAX_OUTBOX) outbox.delete(outbox.keys().next().value as string);
  persist();
  void flushTranscript();
}

/** Whether a failed send is worth keeping. Only a request the server will never accept is dropped;
 *  everything else — an expired cookie, a 404 while a deploy rolls out, a rate limit, any 5xx — is a
 *  message we still owe the record, so it stays queued for the next flush. */
function isPermanentlyRejected(status: number): boolean {
  return status === 400 || status === 413 || status === 422;
}

/** Send everything queued, grouped by conversation. Anything that fails stays queued for the next
 *  flush — which the recorder also triggers on mount, when connectivity returns, and as the tab closes. */
export async function flushTranscript(): Promise<void> {
  load();
  if (flushing || !owner || outbox.size === 0) return;
  flushing = true;
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
          // Drop by identity, not by key: a revision queued while this batch was in flight is a
          // different object under the same id, and deleting it would lose the newer wording.
          for (const q of batch) if (outbox.get(q.clientMessageId) === q) outbox.delete(q.clientMessageId);
          persist();
        }
        if (stalled) break;
      }
      if (stalled) return;
    }
  } finally {
    flushing = false;
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
