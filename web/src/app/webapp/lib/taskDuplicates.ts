// Is this to-do already on the list?
//
// The reported failure: asked to put something on the list, the assistant added it — again. The user's
// screenshot shows two identical "Enroll with a GP" tasks and a reply cheerfully mentioning "both of
// your 'Enroll with a GP' tasks", leaving them to ask for one to be deleted. Nothing checked: add_task
// created a row every time it was called, and the only duplicate guard in the product is server-side,
// in /sync (exact title + exact due date), which the in-chat tools don't go through.
//
// So the check moves in FRONT of the add, and it is split the same way the rest of the task safety
// nets are (see taskIntent.ts):
//
//   - WHETHER a title is already there is decided here, by code. It can't be talked out of it.
//   - WHAT to do about it stays with the model: add_task hands back the matching task(s) instead of
//     creating anything, and the reply raises it with the user ("you've already got that one — still
//     want a second?"). Only an explicit go-ahead (allowDuplicate) adds it anyway.
//
// Tuned to catch a re-add, not to be clever: exact wording first, then a distinguishing-token overlap
// so "Enrol with a GP" still finds "Enroll with a GP" and "pay rent" finds "pay rent for August". A
// false positive costs one question to the user; a false negative is exactly today's behaviour.

import type { Task } from "./tasks";

/** Case-, spacing- and punctuation-insensitive form, so "Buy a bedside table." and "buy a bedside
 *  table" are the same name. Strips punctuation/symbols only — CJK titles survive. Shared with the
 *  title matching in taskTools.ts so both sides of the feature agree on what "the same name" means. */
export const normalizeTitle = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Words that turn up in any to-do, so a hit on one says nothing about WHICH task it is. Deliberately
 *  short and grammatical: verbs stay in, because "buy milk" and "buy bread" are different tasks and
 *  "buy" is half of what keeps them apart. */
const STOPWORDS = new Set([
  "a", "an", "the", "to", "for", "of", "on", "in", "at", "by", "with", "about", "from", "into", "up",
  "and", "or", "but", "my", "me", "i", "our", "your", "it", "its", "this", "that", "these", "those",
  "is", "am", "are", "be", "been", "do", "does", "did", "go", "get", "got", "have", "has", "had",
  "need", "needs", "please", "some", "any", "again", "also", "still", "then", "there", "here",
]);

/**
 * The distinguishing pieces of a title. Latin-script words survive whole (minus stopwords), and no
 * minimum length — "GP" is the entire point of "enrol with a GP". CJK, which has no spaces to split
 * on, contributes character bigrams so 预约 is matched inside a longer run.
 */
function tokens(normalized: string): string[] {
  const out = new Set<string>();
  for (const word of normalized.split(" ")) {
    if (!word) continue;
    if (CJK.test(word)) {
      if (word.length === 1) out.add(word);
      for (let i = 0; i + 2 <= word.length; i++) out.add(word.slice(i, i + 2));
    } else if (!STOPWORDS.has(word)) {
      out.add(word);
    }
  }
  return [...out];
}

/** Two tokens count as the same word when one is a prefix of the other — "enrol"/"enrolling",
 *  "book"/"booking". Length-guarded so a fragment can't stand in for a word (and so CJK bigrams,
 *  which are two characters, only ever match exactly). */
const PREFIX_MATCH_CHARS = 4;
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= PREFIX_MATCH_CHARS && long.startsWith(short);
}

/** How much of the shorter title's distinguishing words the longer one has to echo. Measured against
 *  the SHORTER side on purpose: "pay rent" is already on the list when "pay rent for August" arrives. */
const SIMILAR_ENOUGH = 0.6;

/**
 * Do these two titles name the same to-do? Exact (normalized) wording first, then the token overlap
 * above. Titles with nothing distinguishing left (all stopwords) fall back to containment rather than
 * dividing by zero.
 */
export function titlesLookAlike(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = tokens(na);
  const tb = tokens(nb);
  if (ta.length === 0 || tb.length === 0) return na.includes(nb) || nb.includes(na);
  const [small, large] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const hits = small.filter((s) => large.some((l) => sameWord(s, l))).length;
  return hits / small.length >= SIMILAR_ENOUGH;
}

/**
 * The tasks in `tasks` that already say what `title` says. The caller decides what goes in — in
 * practice the user's OPEN tasks, because a done or dismissed one is no reason to refuse a re-add.
 * Dates are deliberately NOT part of the test: "gym on Tuesday" when gym already sits on Monday is
 * still worth raising, and the model can reschedule the one they have instead of adding a second.
 */
export function findSimilarTasks(title: string, tasks: Task[]): Task[] {
  const t = title.trim();
  if (!t) return [];
  return tasks.filter((task) => titlesLookAlike(t, task.title));
}

// --- The same turn's own adds ---
//
// The server list can't see an add that hasn't landed yet, and tool calls in a Live turn are dispatched
// in PARALLEL (see liveShared.ts): two add_task calls for the same thing both read the list before
// either write reaches it, and both create. So a title is claimed synchronously — before any await —
// and released once the create settles. Nothing here survives the request that made it: a claim that
// outlived its add would block a legitimate re-add later.

const claimed = new Map<string, number>();
let claimSeq = 0;

/**
 * Claim `title` for an add that is about to run. Returns the clashing title when this page is already
 * mid-add on something that looks the same, in which case NOTHING is claimed and the caller must not
 * create. Otherwise returns `release`, which the caller must call once its create has settled — on
 * failure as much as on success, or a failed add would poison the next attempt.
 */
export function claimAdd(title: string): { clash: string | null; release: () => void } {
  const t = title.trim();
  for (const pending of claimed.keys()) {
    if (titlesLookAlike(t, pending)) return { clash: pending, release: () => {} };
  }
  const id = ++claimSeq;
  claimed.set(t, id);
  return {
    clash: null,
    // Guarded by id so a release can only ever drop its own claim, never a later one for the same title.
    release: () => {
      if (claimed.get(t) === id) claimed.delete(t);
    },
  };
}
