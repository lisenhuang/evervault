// The safety net for a request that never became a task.
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
