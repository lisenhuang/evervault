// The guarantee that a to-do change is never invisible.
//
// Everything else about the task list is prompt: the model is told to act on an explicit "add this to
// my to-do list" first and confirm what it saved. In prod it kept not doing it — most sharply on the
// FIRST message of a conversation, where a request to add a locksmith's number came back as "Morning!
// Just a heads-up that you have a hospital visit today", the task neither added nor mentioned. The user
// had to send a second message to find out whether anything had happened at all.
//
// Prompt rules can lose; a tool result cannot. So this closes the loop deterministically: the surface
// collects what the task tools ACTUALLY changed during the turn, checks the finished reply against it,
// and appends a short factual line for anything the reply never mentioned. It reports only what the
// server confirmed — the same rule the task persona holds the model to — and stays silent when the
// model already did its job, so a well-behaved reply reads exactly as it does today.

import { htmlLang, type Lang } from "@/i18n/config";
import type { Messages } from "@/i18n/messages/en";
import { titlesLookAlike } from "./taskDuplicates";
import type { ChangedTask, TaskChange, TaskChangeKind } from "./taskTools";

/** Case-, spacing- and punctuation-insensitive form, so "Fix the door lock." and "fix the door lock"
 *  are the same words. Strips punctuation/symbols only — CJK survives. Mirrors taskTools' normalizer. */
const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Words shorter than this ("a", "to", "的") carry no identifying signal, so they don't count towards
 *  coverage — otherwise a reply containing "the" would look like it named the task. */
const MIN_TOKEN_CHARS = 3;
/** How much of a title the reply must echo to count as having mentioned it. Deliberately generous:
 *  a false "already mentioned" just leaves today's behaviour alone, whereas a false "never mentioned"
 *  only costs a redundant line — the cheaper mistake by far. */
const TOKEN_COVERAGE = 0.6;

/**
 * Did the finished reply actually tell the user about this task? Exact (normalized) containment first,
 * then a word-overlap fallback so a model that reflows the title ("your door lock repair") still counts
 * as having said it. A title with no separable words (CJK, which normalize can't tokenize) falls back
 * to containment alone.
 */
export function replyMentionsTask(reply: string, title: string): boolean {
  const t = normalize(title);
  if (!t) return true; // nothing identifiable to check for — don't manufacture a line about it
  const r = normalize(reply);
  if (!r) return false;
  if (r.includes(t)) return true;
  const tokens = t.split(" ").filter((w) => w.length >= MIN_TOKEN_CHARS);
  if (tokens.length < 2) return false;
  const hits = tokens.filter((w) => r.includes(w)).length;
  return hits / tokens.length >= TOKEN_COVERAGE;
}

/** "2026-08-13" → "13 Aug 2026" in the user's chosen display language. Parsed field-by-field as a
 *  LOCAL date: `new Date("2026-08-13")` is UTC midnight, which renders as the day before east of UTC. */
function humanDate(due: string, lang: Lang): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due.trim());
  if (!m) return due;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return due;
  try {
    return d.toLocaleDateString(htmlLang(lang), { dateStyle: "medium" });
  } catch {
    return due;
  }
}

/** The "when" half of a receipt item, or "" for a task with no date. */
function whenLabel(task: ChangedTask, lang: Lang): string {
  const date = task.due ? humanDate(task.due, lang) : "";
  if (!date) return "";
  return task.time ? `${date}, ${task.time}` : date;
}

/**
 * One entry per task, newest snapshot wins. A task added and then edited in the same turn stays
 * "added" — that it is now on the list at all is the news, and the merged entry still carries the
 * final date. Added and then DISMISSED is the exception: it drops out entirely.
 */
function mergeChanges(changes: TaskChange[]): { kind: TaskChangeKind; task: ChangedTask }[] {
  const byId = new Map<number, { kind: TaskChangeKind; task: ChangedTask }>();
  for (const change of changes) {
    for (const task of change.tasks) {
      if (!Number.isFinite(task.id)) continue;
      const prev = byId.get(task.id);
      // Put on the list and taken straight back off within the same turn: the list ends exactly where
      // it started, so there is nothing to tell the user. This is what the stray-task recheck does when
      // it finds a task that came from recalled notes rather than from the request (see taskIntent.ts) —
      // reporting either half of that would be announcing the mistake, or the repair of one the user
      // never saw. Reported neither as an add nor as a removal.
      if (prev?.kind === "added" && change.kind === "dismissed") {
        byId.delete(task.id);
        continue;
      }
      byId.set(task.id, { kind: prev?.kind === "added" ? "added" : change.kind, task });
    }
  }
  return [...byId.values()];
}

/** Reported in a stable order rather than call order, so a turn that adds and completes things reads
 *  the same way every time. "duplicate" sits next to "added" because it answers the same question the
 *  user is asking — did the thing I asked for go on my list? */
const KIND_ORDER: TaskChangeKind[] = ["added", "duplicate", "completed", "dismissed", "updated"];

/**
 * The line(s) to append to a finished reply, or null when there's nothing to add — either because the
 * turn changed no tasks, or because the reply already named every task it changed.
 *
 * `askedToAdd` closes the mirror-image hole. Everything above reports what DID happen, so a reply that
 * changed nothing was free to claim anything: an opening "remind me to register mophiqo.video, add this
 * to todo list" came back as "Done — texting the locksmith to repair your door lock is on your list for
 * August 13" — a task from an earlier conversation, nothing saved, and no way for the user to know. So
 * when their message plainly asked for something to go on the list (see taskIntent.ts) and the turn ends
 * with nothing added, the reply says so outright. Unconditional — NOT gated on replyMentionsTask like
 * the lines above — because the claim being contradicted is exactly the thing that can't be trusted
 * here. The cost when the model behaved correctly and said so itself is one redundant, true sentence.
 *
 * A "duplicate" change is an add that was REFUSED because the task was already there (see
 * taskDuplicates.ts). It reports the task they already have, so a reply that quietly dropped the
 * request still leaves them knowing why nothing new appeared.
 *
 * `reply` is the model's finished text. Kept pure (no React, no network) so it can be reasoned about
 * and reused by any surface.
 */
export function buildTaskReceipt(
  changes: TaskChange[],
  reply: string,
  t: Messages,
  lang: Lang,
  askedToAdd = false,
): string | null {
  const all = mergeChanges(changes);
  // A duplicate the user was told about and then approved: the second copy really is on the list now,
  // so "already there, nothing added" would contradict the add reported beside it. The add is the news.
  const addedTitles = all.filter((m) => m.kind === "added").map((m) => m.task.title);
  const merged = all.filter(
    (m) => m.kind !== "duplicate" || !addedTitles.some((added) => titlesLookAlike(added, m.task.title)),
  );
  // Judged on the MERGED view, so "added" means still on the list when the turn ended — a task added
  // and dismissed again within the turn leaves them with nothing, and this line says exactly that.
  // A refused duplicate is the one case where nothing being added is the correct outcome rather than a
  // miss: its own line below says why, so this one would only contradict it.
  const nothingAdded =
    askedToAdd && !merged.some((m) => m.kind === "added") && !merged.some((m) => m.kind === "duplicate");

  const groups = new Map<TaskChangeKind, string[]>();
  for (const { kind, task } of merged) {
    if (!task.title?.trim()) continue;
    if (replyMentionsTask(reply, task.title)) continue;
    const when = whenLabel(task, lang);
    const item = when ? t.chat.taskReceipt.itemWhen(task.title, when) : task.title;
    groups.set(kind, [...(groups.get(kind) ?? []), item]);
  }

  // "nothing was added" leads: it corrects the reply, whereas the lines below merely complete it.
  const lines = [
    ...(nothingAdded ? [t.chat.taskReceipt.notAdded] : []),
    ...KIND_ORDER.filter((k) => groups.has(k)).map((k) =>
      t.chat.taskReceipt[k](groups.get(k)!.join(t.chat.taskReceipt.separator)),
    ),
  ];
  return lines.length > 0 ? lines.join("\n") : null;
}
