// The safety nets around what a turn did — or didn't — do with the to-do list.
//
// Two failures live here, and both end the same way: the user cannot tell what happened to their
// request. One is a request that never became a task; the other is a task that came from somewhere
// other than the request. Each buys the model exactly ONE more round with the fact stated.
//
// taskReceipt.ts guarantees the user is TOLD about a change; it can only do that once a task tool has
// actually run. The failure underneath is worse and comes first: the model reads "add this to my to-do
// list", never calls add_task at all, and answers with something else entirely. That is what happened
// in prod — an opening message asking for a locksmith call to go on the list got a greeting back, and a
// later session confirmed the task had simply never been created.
//
// So before a turn is allowed to finish, an explicit tracking request that produced no task gets ONE
// more round with the omission pointed out. Deliberately split in two:
//
//   - WHEN to re-ask is deterministic (the markers below). Code decides; it can't be talked out of it.
//   - WHETHER to add anything stays with the model. Nothing here ever creates a task, so a marker that
//     fired on a message that wasn't really a request costs one round and changes nothing.
//
// The markers are therefore tuned for PRECISION, not coverage: only phrasings that unambiguously mean
// the user's list. "Remember this phone number" is not one of them — that's memory, a different
// feature — while "add this to todo list" is.

/** Explicit "put this on my list" phrasings across the four supported display languages. A message the
 *  user typed in some other language simply won't match, which costs nothing: the prompt rules still
 *  apply and this only ever ADDS a second chance. */
const TRACKING_MARKERS: RegExp[] = [
  // English. "remind me" excludes the interrogatives, so "remind me what's on my list" — a question
  // about the list rather than a request to add to it — doesn't trigger a pointless round.
  /\bto-?\s?do\b[\s-]*list\b/i,
  /\btask\s+list\b/i,
  /\bremind\s+me\b(?!\s+(?:what|which|when|where|how|why|who|again|of\s+what)\b)/i,
  /\bset\s+(?:a\s+|the\s+)?reminder\b/i,
  /\bdon'?t\s+(?:let\s+me\s+)?forget\b/i,
  /\badd\s+(?:this|that|it|them)\s+to\s+(?:my\s+)?(?:list|to-?\s?do)/i,
  /\badd\s+(?:it\s+)?to\s+(?:my\s+)?list\b/i,
  /\bput\s+(?:this|that|it|them)\s+on\s+(?:my\s+)?list\b/i,
  // Simplified Chinese
  /待办/,
  /提醒我/,
  /任务(?:清单|列表)/,
  /别忘|別忘/,
  /(?:加到|加入|加进|添加到).{0,4}(?:清单|列表)/,
  // Japanese
  /やること|タスクリスト/,
  /リマインド/,
  /忘れないように/,
  /リストに(?:追加|入れ)/,
  // Korean
  /할\s*일\s*(?:목록|리스트)/,
  /리마인드/,
  /잊지\s*(?:말|않)/,
  /목록에\s*추가/,
];

/**
 * Did this message explicitly ask for something to go on the to-do list? High precision by design —
 * a false positive costs one wasted round, a false negative just leaves today's behaviour alone.
 */
export function asksToTrackSomething(text: string): boolean {
  const s = text.trim();
  if (!s) return false;
  return TRACKING_MARKERS.some((re) => re.test(s));
}

/**
 * The one extra round, sent as a user turn because that is the only channel the tool loop has — hence
 * the opening line telling the model this is not the user speaking. It does NOT instruct the model to
 * add something: it states the fact (a request went untracked), and hands the judgement back. A model
 * that re-reads and decides nothing was asked for is behaving correctly and adds nothing.
 */
export const UNTRACKED_REQUEST_NUDGE =
  "INTERNAL SYSTEM CHECK — this is not from the user. Do not quote it, mention it, apologise for it, " +
  "or let it change your tone. Their last message looks like it asked you to put something on their " +
  "to-do list, and this turn finished without add_task ever being called, so nothing was saved. " +
  "Re-read what they actually said. If they DID ask you to add, remind, track or remember something " +
  "as a to-do, call add_task now (title in their language; resolve any relative date to YYYY-MM-DD; " +
  "omit the date if they gave none) and then write your reply. If they did NOT — if they only asked a " +
  "question about their list, or the wording just resembles a request — add nothing at all. Either " +
  "way, replace your previous reply with one that answers their message properly, and if a task did " +
  "go on the list, say so plainly with its title and date.";

// --- Did this turn's task actually come from what the user said? ---
//
// The second failure, and the one that reads worst: the reply confirms a task the user never mentioned.
// A session opened with "remind me to register mophiqo.video, add this to todo list" and came back with
// "Done — texting the locksmith to repair your door lock (021 2038 035) is on your list for August 13" —
// a request from two days earlier, pulled out of the recalled-notes block and answered in place of the
// live one. recall.ts now states in words that notes are never requests; this is the half that doesn't
// depend on the model reading it.
//
// The signal is lexical and cheap: a task the user really asked for echoes something SOMEONE said in
// this conversation (their own words, or an offer of yours they agreed to). A title that echoes nothing
// in the conversation but does echo the recalled notes came from the notes. Both halves are required —
// that conjunction is what makes it precise enough to act on.

/** Case-, spacing- and punctuation-insensitive form. Mirrors the normalizer in taskReceipt.ts. */
const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** Short words carry no identifying signal. Higher than taskReceipt's bar (3): this check has to be
 *  sure a title is UNgrounded, so its tokens must actually distinguish one task from another. */
const MIN_TOKEN_CHARS = 4;
/** Common enough to appear in any text, so a hit on one says nothing about where a title came from. */
const STOPWORDS = new Set([
  "about", "after", "again", "also", "another", "back", "because", "been", "before", "being", "both",
  "could", "does", "doing", "done", "down", "each", "even", "every", "from", "have", "here", "into",
  "just", "like", "make", "makes", "more", "most", "much", "must", "need", "needs", "next", "once",
  "only", "other", "over", "please", "same", "should", "some", "soon", "still", "such", "sure", "than",
  "that", "their", "them", "then", "there", "these", "they", "thing", "things", "this", "those",
  "through", "time", "very", "want", "wants", "well", "were", "what", "when", "where", "which", "will",
  "with", "would", "your", "yours",
]);

/**
 * The distinguishing pieces of a title. Latin-script words survive whole; CJK (which has no spaces to
 * split on) contributes character bigrams, so 门锁 is matched even inside a longer run.
 */
function groundingTokens(text: string): string[] {
  const out = new Set<string>();
  for (const word of normalize(text).split(" ")) {
    if (CJK.test(word)) {
      for (let i = 0; i + 2 <= word.length; i++) out.add(word.slice(i, i + 2));
    } else if (word.length >= MIN_TOKEN_CHARS && !STOPWORDS.has(word)) {
      out.add(word);
    }
  }
  return [...out];
}

/** How much of `title` shows up in `source`, 0–1. Substring rather than whole-word matching, so
 *  "lock" still finds "lock smith" and a CJK bigram finds its run. A title with no distinguishing
 *  tokens at all returns 1: unjudgeable, and this check may only ever fire on a clear signal. */
function grounding(title: string, source: string): number {
  const tokens = groundingTokens(title);
  if (tokens.length === 0) return 1;
  const src = normalize(source);
  if (!src) return 0;
  return tokens.filter((tok) => src.includes(tok)).length / tokens.length;
}

/** It has to be genuinely traceable to the notes, not merely share a word with them. */
const IN_NOTES = 0.5;

/**
 * Which of the titles added this turn look like they came from the recalled notes rather than from the
 * conversation. Empty (the normal case) when there are no notes, or every title traces back to what was
 * actually said.
 *
 * The conversation side is judged at ZERO tolerance — not one distinguishing word of the title echoes
 * anything said this conversation — rather than on a fraction. It reads as the plainer claim (nobody
 * here has mentioned this) and it is much the harder thing to trigger by accident, which matters
 * because the round this buys can end with the task being taken back off the list. "Put that locksmith
 * thing on my list" is a single word of overlap, and a single word is enough to mean the user is the
 * one who brought it up. The reported failure has no overlap at all: a to-do about a door lock, in a
 * conversation whose only message is about submitting an app and registering a domain.
 *
 * `conversation` is everything said in this conversation up to and including the user's latest message —
 * NOT the reply being composed, whose whole problem is that it names the stray task.
 */
export function straySavedTasks(titles: string[], conversation: string, notes: string | null): string[] {
  if (!notes?.trim()) return [];
  // Nothing quotable was said (a voice clip whose transcript never landed, say). "No overlap" would be
  // vacuously true against that, so every task would look stray — judge nothing instead.
  if (groundingTokens(conversation).length === 0) return [];
  return titles.filter(
    (title) => title.trim() && grounding(title, conversation) === 0 && grounding(title, notes) >= IN_NOTES,
  );
}

/** Same contract as UNTRACKED_REQUEST_NUDGE: states a fact, creates and undoes nothing itself, and
 *  hands the judgement back. A model that re-reads and concludes the task was genuinely asked for keeps
 *  it — the round costs one reply and changes nothing else. */
export const strayTaskNudge = (titles: string[]): string =>
  "INTERNAL SYSTEM CHECK — this is not from the user. Do not quote it, mention it, apologise for it, " +
  "or let it change your tone. This turn put the following on their to-do list: " +
  titles.map((t) => `"${t}"`).join(", ") +
  ". Nothing matching that appears anywhere in this conversation, but it does appear in your recalled " +
  "notes from an earlier one — which are background, never a live request. Re-read the user's latest " +
  "message. If they really did ask for this, even indirectly, keep it and confirm it as normal. If they " +
  "did not, you have acted on an old request instead of theirs: take it off the list (update_task with " +
  'status "dismissed" — do not leave a task they never asked for), and then answer what they ACTUALLY ' +
  "said, adding what they did ask for if they asked for anything. Replace your previous reply either " +
  "way, and never present something from the notes as a thing you just did for them.";

/**
 * The one extra round this turn should get, or null when it can finish as it is. At most one check
 * fires: a turn that saved nothing can't also have saved the wrong thing.
 */
export function buildRecheckNudge(opts: {
  /** What the user said this turn (their typed message, or a voice clip's transcript). */
  userText: string;
  /** Titles of the tasks add_task actually created this turn, as the server returned them. */
  addedTitles: string[];
  /** Titles add_task REFUSED to create this turn because the user already had them (see
   *  taskDuplicates.ts). A tracking request that ends this way has been handled — the model was handed
   *  the task they already have and told to raise it — so the untracked nudge must not fire and send it
   *  back to add the second copy this whole check exists to prevent. */
  duplicateTitles?: string[];
  /** Everything said in this conversation through the user's latest message. */
  conversation: string;
  /** The recalled-notes block injected into this turn's system instruction, if any. */
  notes: string | null;
}): string | null {
  if (opts.addedTitles.length === 0) {
    if (opts.duplicateTitles?.length) return null;
    return asksToTrackSomething(opts.userText) ? UNTRACKED_REQUEST_NUDGE : null;
  }
  const stray = straySavedTasks(opts.addedTitles, opts.conversation, opts.notes);
  return stray.length > 0 ? strayTaskNudge(stray) : null;
}
