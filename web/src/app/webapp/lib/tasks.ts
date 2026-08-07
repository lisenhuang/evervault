// Structured task list — the thing that makes "what do I need to do today?" reliable. Unlike free-text
// chat memory (indexed by when it was said), a task has an explicit due date, so the agenda ("due today +
// overdue") is a deterministic block injected into every chat rather than a semantic guess. Tasks are
// extracted in the browser (the user's own Gemini key) or created by the in-chat task tools; the server
// only stores and serves them. All writes are fire-and-forget and must never block the chat.

import { api, postJsonBeacon } from "../authApi";
import { describeRecurrence, localDateStr, rollForward } from "./recurrence";

export type Task = {
  id: number;
  title: string;
  details: string | null;
  dueDate: string | null; // "YYYY-MM-DD" (civil date) or null
  dueTime: string | null; // "HH:mm" or null
  status: string; // "open" | "done" | "dismissed"
  source: string; // "extracted" | "user" | "ai"
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** Repeat rule token (see lib/recurrence.ts), or null/absent for a one-off. Optional so a response
   * from a server that predates recurrence still parses. */
  recurrence?: string | null;
  /** When the latest occurrence of a repeating task was ticked off. A repeating row never sets
   * `completedAt` — that would read as "finished for good". */
  lastCompletedAt?: string | null;
};

export type TaskDelta = {
  adds?: { title: string; details?: string; dueDate?: string; dueTime?: string }[];
  completes?: number[];
  dismisses?: number[];
};

// --- API helpers (same-origin; the user's key never leaves the browser) ---

/** How many rows we ever ask the server for. This is the API's own ceiling (it clamps `take` to 200),
 *  which is the point: a response shorter than this is provably the user's WHOLE list rather than the
 *  first page of it. That's what lets the agenda block state a total and list_tasks tell the model
 *  outright that it has seen everything — neither of which is safe to say off a partial read. */
export const TASK_FETCH_TAKE = 200;

/**
 * The tasks themselves, or null when the READ FAILED. "No tasks" and "couldn't find out" are not the
 * same answer, and only this function can tell them apart: everything downstream sees an empty array
 * for both. That distinction only started mattering once a caller began asserting completeness off an
 * empty result — "your list is empty" told to a user whose network blipped is a straight falsehood,
 * and it is the one sentence that stops them checking. Callers that just want the list use getTasks.
 */
export async function fetchTasks(status = "open", take = TASK_FETCH_TAKE): Promise<Task[] | null> {
  try {
    const res = await api(`/api/chat/tasks?status=${encodeURIComponent(status)}&take=${take}`);
    if (res.ok) return (await res.json()) as Task[];
  } catch {
    /* ignore */
  }
  return null;
}

export async function getTasks(status = "open", take = TASK_FETCH_TAKE): Promise<Task[]> {
  return (await fetchTasks(status, take)) ?? [];
}

export async function createTask(
  t: {
    title: string;
    details?: string;
    dueDate?: string;
    dueTime?: string;
    recurrence?: string;
    conversationId?: string;
  },
  source: "user" | "ai",
): Promise<Task | null> {
  try {
    const res = await api("/api/chat/tasks", { method: "POST", body: JSON.stringify({ ...t, source }) });
    if (res.ok) return (await res.json()) as Task;
  } catch {
    /* ignore */
  }
  return null;
}

export async function patchTask(
  id: number,
  patch: {
    title?: string;
    details?: string;
    dueDate?: string;
    dueTime?: string;
    recurrence?: string;
    status?: string;
  },
): Promise<Task | null> {
  try {
    const res = await api(`/api/chat/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
    if (res.ok) return (await res.json()) as Task;
  } catch {
    /* ignore */
  }
  return null;
}

/** Apply an extraction delta. Fire-and-forget, like syncProfile. Beacon-style so a distillation kicked
 * off by `pagehide` still lands after the tab is gone. */
export function syncTasks(delta: TaskDelta, conversationId: string): void {
  if (!delta.adds?.length && !delta.completes?.length && !delta.dismisses?.length) return;
  void postJsonBeacon("/api/chat/tasks/sync", { ...delta, conversationId }).catch(() => {});
}

export async function deleteTask(id: number): Promise<void> {
  try {
    await api(`/api/chat/tasks/${id}`, { method: "DELETE" });
  } catch {
    /* ignore */
  }
}

export async function clearTasks(): Promise<void> {
  try {
    await api("/api/chat/tasks?all=true", { method: "DELETE" });
  } catch {
    /* ignore */
  }
}

// --- Local date helpers (the user's wall calendar, NOT UTC) ---

// Defined in ./recurrence (which needs it for every date it computes) and re-exported here, where
// callers have always imported it from. One implementation, no drift, and no import cycle between the
// two modules.
export { localDateStr };

// --- Recurrence catch-up ---

/**
 * Roll every overdue repeating task forward to its next occurrence, returning the updated list. This
 * is the *only* recurrence clock: there is no timer and no server sweep, so it runs opportunistically
 * whenever we refresh tasks — which is the sole moment it matters, since the reminder can only ever
 * surface while the user is here.
 *
 * A row is only treated as moved once the server confirms the new date. `patchTask` swallows every
 * error and returns null, and the API answers 200-with-the-old-date for a date it can't parse, so
 * trusting the optimistic value would leave the agenda telling the model a chore is due today while
 * the server still has it overdue — and would re-issue the same doomed PATCH on every refresh.
 */
export async function catchUpRecurring(tasks: Task[], today = localDateStr()): Promise<Task[]> {
  const stale = tasks.filter(
    (t) => t.status === "open" && t.recurrence && rollForward(t.recurrence, t.dueDate, today),
  );
  if (stale.length === 0) return tasks;

  const moved = new Map<number, Task>();
  await Promise.all(
    stale.map(async (t) => {
      const next = rollForward(t.recurrence, t.dueDate, today);
      if (!next) return;
      const saved = await patchTask(t.id, { dueDate: next });
      if (saved && saved.dueDate === next) moved.set(t.id, saved);
    }),
  );
  return moved.size === 0 ? tasks : tasks.map((t) => moved.get(t.id) ?? t);
}

// --- Injection: render the open tasks as a deterministic agenda block ---

const OVERDUE_CAP = 5;
const TODAY_CAP = 7;
const UNDATED_CAP = 5;

/** A compact "what's on your plate" block for the system instruction, or null when nothing is open.
 * Deterministic (no model call): partitions open tasks into overdue / due today / undated, relative to
 * the user's local `now`. Future-dated tasks are omitted here (reachable via the list_tasks tool). Ids
 * are rendered so the model can complete/update a task by id. Re-render every turn so tool-driven
 * changes show up mid-conversation. */
/** What the model is told when the user has no open tasks at all. Explicit, because "nothing on your
 *  list" is a correct and useful answer, whereas an absent block invites the model to improvise one. */
const EMPTY_AGENDA_BLOCK =
  "The user's task list (structured, authoritative — this is the ground truth for what they need to do). " +
  "IT IS CURRENTLY EMPTY: they have no open tasks. If they ask what they need to do, what's on their " +
  "plate, or whether anything is due, the answer is that their list is clear — say so plainly. Do NOT " +
  "fill the gap from memory: things you remember from past conversations, goals, or open loops are not " +
  "tasks and must not be offered as though they were on the list. If you think something is worth " +
  "tracking, you may offer to ADD it, making clear it isn't on the list yet. Use list_tasks to check " +
  "other dates before concluding anything about a day other than today.";

/**
 * The authoritative "what does this user actually have to do" block.
 *
 * Returns a block even when the list is EMPTY, which matters more than it looks: an omitted block is
 * silence, and the model fills silence from whatever else is in the prompt — the profile's goals and open
 * loops, or summaries of past chats. That is exactly how remembered asides ("set up auto payments for
 * rent") get served back as though they were on the to-do list. Saying "the list is empty" out loud makes
 * "nothing" a real, quotable answer instead of a gap.
 */
export function renderAgendaBlock(tasks: Task[], now = new Date()): string | null {
  const open = tasks.filter((t) => t.status === "open");
  if (open.length === 0) return EMPTY_AGENDA_BLOCK;
  const today = localDateStr(now);

  const overdue = open
    .filter((t) => t.dueDate && t.dueDate < today)
    .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : 1));
  const dueToday = open.filter((t) => t.dueDate === today);
  const undated = open
    .filter((t) => !t.dueDate)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  // Everything dated after today. Deliberately COUNTED but not listed (that's what list_tasks is for) —
  // yet counting it is not optional: without this line the four buckets don't add up to the open list,
  // and a block that looks complete while silently hiding tasks is what made the assistant answer
  // "nothing today" and then keep dredging up the same undated pair when pushed for more.
  const later = open.filter((t) => t.dueDate && t.dueDate > today);

  const line = (t: Task, suffix = "") => {
    const repeat = t.recurrence ? ` (repeats ${describeRecurrence(t.recurrence)})` : "";
    return `- [#${t.id}] ${t.title}${t.dueTime ? ` at ${t.dueTime}` : ""}${repeat}${suffix}`;
  };
  const section = (heading: string, items: Task[], cap: number, mk: (t: Task) => string) => {
    if (items.length === 0) return [];
    const shown = items.slice(0, cap).map(mk);
    if (items.length > cap) shown.push(`- (+${items.length - cap} more — use list_tasks to see them)`);
    return [heading, ...shown];
  };

  const lines: string[] = [];
  lines.push(...section("Overdue:", overdue, OVERDUE_CAP, (t) => line(t, ` (was due ${t.dueDate})`)));
  lines.push(...section(`Due today (${today}):`, dueToday, TODAY_CAP, (t) => line(t)));
  lines.push(...section("No due date:", undated, UNDATED_CAP, (t) => line(t)));
  if (later.length > 0) {
    lines.push(
      `Dated later than today: ${later.length} more task(s) — NOT listed here, and none of them due ` +
        "yet. Call list_tasks to see them (pass a dueOnOrBefore for a range, or no filter at all for " +
        "the whole open list). Don't raise these unprompted.",
    );
  }
  // Every open task falls into exactly one bucket above, so this can now only be reached with an empty
  // list — kept as a backstop rather than as a live path.
  if (lines.length === 0) return EMPTY_AGENDA_BLOCK;

  // At the fetch ceiling the count is a floor, not a total — say so rather than assert a number that
  // may be short. (Not a state any real list reaches; it just must never read as fact if it does.)
  const total = open.length >= TASK_FETCH_TAKE ? `${TASK_FETCH_TAKE}+` : `${open.length}`;
  return (
    `The user's task list — ${total} open task(s) in total (structured, authoritative — this is ` +
    "the ground truth for what they need to do; prefer it over conversational memory when they ask " +
    "what's on their plate, and never invent tasks that aren't listed here or returned by list_tasks). " +
    "Talk about tasks by title, not by id number — but pass the id to the task tools. This is a " +
    "SNAPSHOT taken before your reply: once you complete, dismiss or reschedule anything, the tool's " +
    "response is newer than this list, and list_tasks is what tells you the state now — so never " +
    "re-read this block to check whether a change of yours went through. It is also only the part of " +
    "the list that matters TODAY (overdue, due today, undated); anything dated further out is counted " +
    "at the end but not shown — so this block is NOT the whole list, and \"that's everything\" is " +
    "never something you can say from it alone. Check list_tasks first:\n" +
    lines.join("\n")
  );
}
