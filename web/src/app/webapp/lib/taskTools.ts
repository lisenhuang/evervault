// The task tools — let the model read and manage the user's structured task list from inside a chat.
// Shared by the text chat (gemini.ts) and the realtime voice call (liveSession.ts) so both surfaces
// expose the same capability. Reuses the /api/chat/tasks endpoints; no new network code. The injected
// agenda block (renderAgendaBlock) already shows today's + overdue tasks; these tools cover the rest:
// looking further out, and adding/completing/rescheduling on the fly.

import { Type, type FunctionDeclaration } from "@google/genai";
import { describeRecurrence, firstOccurrence, isRecurring, nextOccurrence } from "./recurrence";
import { createTask, getTasks, localDateStr, patchTask, type Task } from "./tasks";
import { formatMemoryDate } from "./time";

// Persona addendum for the task list. Prepend alongside MEMORY_PERSONA on both surfaces.
export const TASKS_PERSONA =
  "You also manage this user's structured task list. The current task list (overdue, due today, and " +
  "undated) may be shown to you above as an authoritative block; when the user asks what they need to " +
  "do — today, this week, or in general — answer from that list and from the list_tasks tool, not from " +
  "vague memory. Use list_tasks for anything beyond what's shown (e.g. a specific future date or 'this " +
  "week'), computing any date from the current local date/time you were given. Never put a task on the " +
  // The reported failure: the user explicitly said "remind me… add to to-do list" and the assistant
  // opened with a greeting + an unrelated due-task heads-up, never adding the task or saying whether it
  // had — so the user had to ask "have you added this?" to find out. The rule below makes an explicit
  // request resolve-and-confirm in the SAME reply, while a to-do that merely comes up still needs an ask.
  "list on your own initiative — how you handle a to-do depends on how it comes up. When the user " +
  "EXPLICITLY asks you to add, remind, or remember something (\"remind me to X\", \"don't let me forget " +
  "X\", \"add X to my to-do list\"), that request IS their go-ahead: resolving it is the first thing your " +
  "next reply does — add it and confirm what you saved, the title plus the date if there is one (\"Done — " +
  "renewing your CMB card is on your list for 1 Sep\"), never re-asking something they've already " +
  "answered and never leaving them to chase you to find out whether it happened. When a to-do instead " +
  "just COMES UP in passing, with no request to track it, don't add it silently: first ASK whether they " +
  "want it on the list, and add it only once they say yes — every task added this way needs their " +
  "go-ahead. Stop to ask a clarifying question only when a genuinely required detail is missing or " +
  "unclear, then ask just the ONE thing you need; a missing date is never a blocker — add it undated " +
  "rather than stall. Never bury an explicit request under a greeting, small talk, or a what's-due " +
  "heads-up: acting on what they just asked comes first, and a due-task mention can ride alongside, not " +
  "instead. Once a task is going on the list, resolve relative dates ('tomorrow', 'next Friday') into a " +
  "YYYY-MM-DD date, and omit the date if they didn't give one. When the user says something is done, " +
  "call complete_task with its id; use update_task to reschedule a task or to dismiss one they no longer " +
  "want (dismiss, don't complete, when it wasn't actually done). Refer to tasks by their title when you " +
  "talk to the user, never by id number — but always pass the id(s) to the tools themselves — and never " +
  "invent tasks that aren't on the list. " +
  "If the user says they don't recognise a task you raised, do NOT apologise it away, claim you made it " +
  "up, or tell them to ignore it — the task list shown to you is authoritative. Check it (use list_tasks " +
  "to look it up by name), and if it really is on the list, say so plainly, tell them where it came from " +
  "and when if you have that (you may be shown it was one you added from an earlier chat, one auto-noted " +
  "from a past conversation, or one they added themselves), and offer to remove, reschedule, or keep it. " +
  "Only treat a task as non-existent if it genuinely isn't on the list or returned by list_tasks.\n\n" +
  // The reported failure: asked "anything I need to do today?", the assistant offered two things the
  // user had merely MENTIONED in past chats ("the EverVault video demo", "auto payments for rent") as
  // though they were open tasks — they were open-loop/goal memories, not list items. Asked to remove
  // one, it said "consider it sorted" about a task that never existed, inventing an action to match
  // its own earlier mistake.
  "WHERE A TO-DO MAY COME FROM. When the user asks what they need to do — today, this week, or at all — " +
  "the ONLY sources are the task list block above and list_tasks. Nothing else in your context is a " +
  "to-do: not what you remember about them, not their goals or open loops, not summaries of past " +
  "conversations, not something they mentioned wanting to do once. Those are things you KNOW, not " +
  "things they OWE, and presenting one as an open task tells them they have work waiting that they " +
  "never actually put on their list. If the list is empty, the honest answer is that it's empty — say " +
  "so rather than reaching for something to offer. You may still bring a remembered intention up, but " +
  "only as a memory and an offer: \"you mentioned wanting to X — want me to add it?\", never \"you " +
  "still need to X\" or \"X is on your list\". " +
  "If the user asks you to remove something that turns out not to be on the list, say exactly that — " +
  "it wasn't there — and, if you were the one who raised it, own that plainly. Never say you removed, " +
  "dismissed or sorted a task that never existed: an invented removal leaves them believing their list " +
  "changed when nothing did.\n\n" +
  // The reported failure: asked by voice to remove five tasks, the assistant said "I've dismissed
  // those" without the tool ever confirming it, then — asked to check — reported the same tasks as
  // still there, over and over. Two rules below: do the whole removal in ONE call, and never assert
  // an outcome the tool hasn't returned (re-reading the snapshot block is not checking).
  "REMOVING TASKS — ONE CALL, AND ONLY CLAIM WHAT THE TOOL CONFIRMED. When the user asks you to drop " +
  "several tasks at once (\"remove those items\", \"take those off my list\"), dismiss them ALL in a " +
  "SINGLE update_task call: pass every id in `ids` (or, when you weren't shown their ids, their names " +
  "in `titles`) with status 'dismissed'. Never fire one call and describe the rest as handled too. " +
  "Never tell the user a task is removed, dismissed, done or off their list before the tool has come " +
  "back and confirmed it: report exactly what the response shows, and when it comes back with " +
  "notFound or ambiguous entries, name those tasks and ask which they meant rather than claiming " +
  "everything is gone. If they ask you to check whether something really came off, call list_tasks " +
  "and answer from that — the task list you were shown at the start of your reply is a snapshot taken " +
  "before your changes, so re-reading it is not checking.\n\n" +
  // Without this the whole reminder feature is invisible: the agenda is passive context, so the model
  // reads it and says nothing, and the user has to ask "what's on my list" to ever be reminded.
  "BRING UP WHAT'S DUE. A reminder is only useful if you actually raise it. When a conversation starts " +
  "and something is overdue or due today, mention it yourself, early and briefly, without waiting to be " +
  "asked — warmly and in one line, not as a recited list (\"Morning! Just so you know, cleaning the room " +
  "is on for today.\"). But a request the user just made always comes first — handle that, and let the " +
  "heads-up ride alongside it, never in its place. Raise a given task only once per conversation; if " +
  "they've already told you they " +
  "did it, or they're clearly in the middle of something else, let it go rather than repeating yourself. " +
  "Nothing due means say nothing about tasks at all.\n\n" +
  "REPEATING TASKS. A task can repeat: pass `repeat` to add_task with one of exactly these values — " +
  "`daily`, `weekdays`, `weekends`, `weekly:` plus comma-separated days (e.g. `weekly:mon,thu`), or " +
  "`monthly:` plus a day number (e.g. `monthly:15`). \"Every weekend\" is `weekends`, \"every morning\" " +
  "is `daily`, \"every Tuesday\" is `weekly:tue`. Use the same `repeat` on update_task to change a " +
  "schedule, or pass an empty string to make a task one-off again. Completing a repeating task marks " +
  "THIS occurrence done and the task automatically moves to its next date — so say something like " +
  "\"nice, that's done — the next one's on Saturday\", never that the task is finished for good. If a " +
  "repeat is no longer wanted, dismiss it with update_task. " +
  // The product genuinely cannot contact the user between sessions, and CAPABILITY_BOUNDS forbids
  // implying otherwise. A repeating task changes what's on the list, not what the assistant can do.
  "Be accurate about how a repeating reminder reaches them: it will be waiting at the top of their " +
  "list on the day, and you will bring it up the next time they come and talk to you. You still cannot " +
  "message, notify, alert or ping them on your own — never say or imply that you will.";

export const LIST_TASKS_DECLARATION: FunctionDeclaration = {
  name: "list_tasks",
  description:
    "List the user's tasks. Use for 'what do I need to do', 'what's due this week', to look up a " +
    "task's id before completing or updating it, to look up a specific task BY NAME (pass query) " +
    "when the user asks about or disputes one, and to VERIFY a change you just made when they ask you " +
    "to double-check (this reads the list live; the task list in your instructions is a snapshot from " +
    "before your changes). Results include each task's origin (where/when it came from). Defaults to " +
    "open tasks.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      status: {
        type: Type.STRING,
        description: "Which tasks to return: 'open' (default), 'done', 'dismissed', or 'all'.",
      },
      query: {
        type: Type.STRING,
        description:
          "Optional case-insensitive text matched against task titles — use it to find a specific task " +
          "by name, e.g. to verify one the user says they don't recognise.",
      },
      dueOnOrBefore: {
        type: Type.STRING,
        description:
          "Only return tasks due on or before this YYYY-MM-DD date. Compute it from the current local " +
          "date/time you were given (e.g. the end of this week for 'this week').",
      },
      includeUndated: {
        type: Type.BOOLEAN,
        description: "When dueOnOrBefore is set, also include tasks that have no due date (default true).",
      },
    },
  },
};

export const ADD_TASK_DECLARATION: FunctionDeclaration = {
  name: "add_task",
  description:
    "Add a new task to the user's list. An explicit request to track something (\"remind me to X\", " +
    "\"add X to my to-do list\") already counts as the user's go-ahead — add it right away and confirm " +
    "what you saved in the same reply. Only ask first when a to-do merely came up in passing and they " +
    "haven't asked you to track it — then add it once they say yes.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING, description: "Short imperative task title, in the user's language." },
      details: { type: Type.STRING, description: "Optional extra context." },
      dueDate: {
        type: Type.STRING,
        description:
          "Due date as YYYY-MM-DD. Resolve relative dates ('tomorrow', 'next Friday') from the current " +
          "local date/time you were given. Omit entirely if the user gave no date.",
      },
      dueTime: { type: Type.STRING, description: "Optional clock time as 24-hour HH:mm." },
      repeat: {
        type: Type.STRING,
        description:
          "Optional repeat schedule. Exactly one of: 'daily', 'weekdays', 'weekends', " +
          "'weekly:<days>' with comma-separated day abbreviations (e.g. 'weekly:mon,thu'), or " +
          "'monthly:<day-of-month>' (e.g. 'monthly:15'). Use 'weekends' for \"every weekend\". Omit " +
          "for a one-off task. When set, dueDate is optional — the first occurrence is worked out for " +
          "you — and the task moves to its next date each time it is completed.",
      },
    },
    required: ["title"],
  },
};

// Targeting several tasks in ONE call is deliberate: a spoken "remove those five" that depends on the
// model emitting five separate calls in a single turn routinely lands as two, with all five narrated
// as done. Shared by complete_task and update_task so both mutations have the same reach.
const IDS_PARAM = {
  type: Type.ARRAY,
  items: { type: Type.INTEGER },
  description:
    "Ids of SEVERAL tasks to act on in this one call. Always prefer this over one call per task when " +
    "the user names more than one.",
};

const TITLES_PARAM = {
  type: Type.ARRAY,
  items: { type: Type.STRING },
  description:
    "Which tasks to act on, BY NAME — only for tasks whose id you weren't shown (use list_tasks to " +
    "look ids up when you can). Matched against the user's open tasks; a name matching nothing, or " +
    "more than one task, is left untouched and reported back to you.",
};

export const COMPLETE_TASK_DECLARATION: FunctionDeclaration = {
  name: "complete_task",
  description:
    "Mark task(s) done when the user says they finished them. Use the id from the task list or " +
    "list_tasks — and finish several in ONE call by passing `ids`. For a repeating task this completes " +
    "THIS occurrence and automatically schedules the next one — the response tells you the next date — " +
    "so don't describe it as finished for good.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      id: { type: Type.INTEGER, description: "The task's id (shown as [#id] in the task list)." },
      ids: IDS_PARAM,
      titles: TITLES_PARAM,
    },
  },
};

export const UPDATE_TASK_DECLARATION: FunctionDeclaration = {
  name: "update_task",
  description:
    "Reschedule, edit, or dismiss task(s). Use to change a task's date/title, or to dismiss ones the " +
    "user no longer wants (dismiss rather than complete when they weren't actually done). Dismiss " +
    "several in ONE call by passing every id in `ids` with status 'dismissed'.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      id: { type: Type.INTEGER, description: "The task's id (shown as [#id] in the task list)." },
      ids: IDS_PARAM,
      titles: TITLES_PARAM,
      title: {
        type: Type.STRING,
        description:
          "New title — this RENAMES the task, so only send it when the user wants the wording changed " +
          "(and only with a single id). To say WHICH tasks to change by name, use `titles`.",
      },
      dueDate: {
        type: Type.STRING,
        description: "New due date as YYYY-MM-DD, resolved from the current local date/time. Pass an empty string to clear it.",
      },
      dueTime: { type: Type.STRING, description: "New clock time as HH:mm, or empty string to clear it." },
      repeat: {
        type: Type.STRING,
        description:
          "Change the repeat schedule: 'daily', 'weekdays', 'weekends', 'weekly:<days>' or " +
          "'monthly:<day>'. Pass an empty string to stop it repeating and make it a one-off.",
      },
      status: { type: Type.STRING, description: "'open' to reopen, or 'dismissed' to drop it." },
    },
  },
};

export const TASK_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  LIST_TASKS_DECLARATION,
  ADD_TASK_DECLARATION,
  COMPLETE_TASK_DECLARATION,
  UPDATE_TASK_DECLARATION,
];

const TASK_TOOL_NAMES = new Set(TASK_TOOL_DECLARATIONS.map((d) => d.name));
export const isTaskTool = (name: string) => TASK_TOOL_NAMES.has(name);

// Human, non-over-claiming provenance for a task, so the model can tell the user WHERE a task came from
// when they dispute it — without asserting the user asked for it (the whole reason a task can feel
// unfamiliar is that "ai"/"extracted" ones may not have had an explicit go-ahead). Factual only.
const originOf = (t: Task): string => {
  const when = formatMemoryDate(t.createdAt);
  if (t.source === "user") return `you added this on ${when}`;
  if (t.source === "ai") return `I added this during an earlier conversation on ${when}`;
  if (t.source === "extracted") return `auto-noted from something in a past conversation on ${when}`;
  return `on your list since ${when}`;
};

const brief = (t: Task) => ({
  id: t.id,
  title: t.title.length > 200 ? t.title.slice(0, 200) + "…" : t.title,
  due: t.dueDate,
  time: t.dueTime,
  status: t.status,
  // Where/when this task originated — lets the model defend a disputed task ("I added this on…") instead
  // of caving. Factual, and only surfaced through this tool (not recited in the passive agenda block).
  origin: originOf(t),
  // Described in words rather than as the raw token, so the model never reads an internal format
  // aloud. Omitted entirely for one-off tasks to keep the payload small.
  ...(t.recurrence ? { repeats: describeRecurrence(t.recurrence) } : {}),
});

// --- Which tasks a mutating call is aimed at ---

/** Shortest normalized text allowed to match a title by containment: fragments like "pay" would
 *  otherwise sweep in every unrelated task that happens to contain them. */
const MIN_PARTIAL_MATCH_CHARS = 3;

/** Case-, spacing- and punctuation-insensitive form of a title, so "Buy a bedside table." and
 *  "buy a bedside table" are the same name. Strips punctuation/symbols only — CJK titles survive. */
const normalizeTitle = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

type Targets = {
  /** Ids to act on, de-duplicated, in the order the model named them. */
  ids: number[];
  /** Names that matched no open task — reported back so the model can say so instead of assuming. */
  notFound: string[];
  /** Names that matched several open tasks — left untouched; the model has to ask which one. */
  ambiguous: { name: string; matches: string[] }[];
};

/**
 * Resolve the tasks a mutating call targets: a single `id`, a list of `ids`, and/or a list of `titles`
 * matched against the user's OPEN tasks. Bulk targeting is what makes "remove those five" a single
 * tool call; title matching is the safety net for tasks whose id the model was never shown (the agenda
 * block caps each section). A name that matches nothing — or more than one task — is never guessed at:
 * it comes back in notFound/ambiguous so the reply can be honest about what wasn't touched.
 */
async function resolveTargets(args: Record<string, unknown>): Promise<Targets> {
  const out: Targets = { ids: [], notFound: [], ambiguous: [] };
  const seen = new Set<number>();
  const add = (n: number) => {
    if (!Number.isFinite(n) || seen.has(n)) return;
    seen.add(n);
    out.ids.push(n);
  };
  if (args.id !== undefined && args.id !== null) add(Number(args.id));
  // A model that means "12 and 14" sometimes sends the string "12, 14" for an array-typed field.
  // Reading it is free; ignoring it is a call that silently changes nothing — the failure mode this
  // whole path exists to prevent.
  const idList = Array.isArray(args.ids)
    ? args.ids
    : typeof args.ids === "string"
      ? args.ids.split(/[^0-9]+/).filter(Boolean)
      : [];
  for (const v of idList) add(Number(v));

  const rawNames = Array.isArray(args.titles) ? args.titles : typeof args.titles === "string" ? [args.titles] : [];
  const names = rawNames.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean);
  if (names.length === 0) return out;

  // Exact (normalized) match wins; only then containment, which is length-guarded so a fragment can't
  // sweep in half the list.
  const pick = (list: Task[], q: string) => {
    const exact = list.filter((t) => normalizeTitle(t.title) === q);
    if (exact.length) return exact;
    return list.filter((t) => {
      const title = normalizeTitle(t.title);
      if (q.length >= MIN_PARTIAL_MATCH_CHARS && title.includes(q)) return true;
      return title.length >= MIN_PARTIAL_MATCH_CHARS && q.includes(title);
    });
  };

  const open = await getTasks("open");
  let closed: Task[] | null = null;
  for (const name of names) {
    const q = normalizeTitle(name);
    if (!q) continue;
    let hits = pick(open, q);
    if (hits.length === 0) {
      // Nothing open by that name: look at the closed ones too, so reopening by name works and the
      // model can say "that one's already off your list" instead of "I can't find it".
      closed ??= (await getTasks("all")).filter((t) => t.status !== "open");
      hits = pick(closed, q);
    }
    if (hits.length === 1) add(hits[0].id);
    else if (hits.length === 0) out.notFound.push(name);
    else out.ambiguous.push({ name, matches: hits.map((t) => t.title) });
  }
  return out;
}

/** The unmatched names, folded into a tool response only when there are any. */
const missedNames = (t: Targets) => ({
  ...(t.notFound.length ? { notFound: t.notFound } : {}),
  ...(t.ambiguous.length ? { ambiguous: t.ambiguous } : {}),
});

/** How many open tasks are left (with the first few), read back from the server AFTER a change. The
 *  agenda block in the model's instructions is a snapshot from before the call, so without this the
 *  reply's "that's off your list now" is asserted against stale context — the exact loop where the
 *  assistant kept reporting just-dismissed tasks as still there. */
const STILL_OPEN_SHOWN = 12;
async function remainingOpen(): Promise<{ openCount: number; stillOpen: { id: number; title: string }[] }> {
  const open = await getTasks("open");
  return {
    openCount: open.length,
    stillOpen: open.slice(0, STILL_OPEN_SHOWN).map((t) => ({ id: t.id, title: t.title })),
  };
}

/**
 * Execute a task tool call. `args` is the model-supplied object (untyped per the SDK), so every field
 * is coerced defensively. `onChanged` fires after any successful mutation so the caller can refresh its
 * agenda cache. Returns a compact JSON string for the model to read; never throws (a thrown error would
 * break the function-call loop) — failures come back as a JSON `{ error }` the model can relay.
 */
export async function runTaskTool(
  name: string,
  args: Record<string, unknown>,
  onChanged?: () => void,
  conversationId?: string,
): Promise<string> {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

  if (name === "list_tasks") {
    const status = str(args.status) ?? "open";
    const cutoff = str(args.dueOnOrBefore);
    const query = str(args.query)?.toLowerCase();
    const includeUndated = args.includeUndated !== false;
    let tasks = await getTasks(["open", "done", "dismissed", "all"].includes(status) ? status : "open");
    if (cutoff) tasks = tasks.filter((t) => (t.dueDate ? t.dueDate <= cutoff : includeUndated));
    if (query) tasks = tasks.filter((t) => t.title.toLowerCase().includes(query));
    if (tasks.length === 0) return JSON.stringify({ tasks: [], note: "no matching tasks" });
    return JSON.stringify({ tasks: tasks.slice(0, 50).map(brief) });
  }

  if (name === "add_task") {
    const title = str(args.title);
    if (!title) return JSON.stringify({ error: "a title is required" });
    const repeat = str(args.repeat);
    if (repeat && !isRecurring(repeat)) {
      // Tell the model what it got wrong rather than silently dropping the schedule — otherwise it
      // reports "set to repeat every weekend" for a task that is actually a one-off.
      return JSON.stringify({
        error:
          "unrecognised repeat schedule; use daily, weekdays, weekends, weekly:<days> or monthly:<day>",
      });
    }
    // Anchor the series so a repeating task always has a first date: without one there is nothing to
    // roll forward from, and the task would sit undated forever instead of coming due.
    const dueDate = str(args.dueDate) ?? (repeat ? firstOccurrence(repeat) ?? undefined : undefined);
    const task = await createTask(
      { title, details: str(args.details), dueDate, dueTime: str(args.dueTime), recurrence: repeat, conversationId },
      "ai",
    );
    if (!task) return JSON.stringify({ error: "could not add the task" });
    onChanged?.();
    return JSON.stringify({ ok: true, task: brief(task) });
  }

  // Both mutations below act on however many tasks the call named (see resolveTargets): one PATCH per
  // target, run together, with every outcome reported. Nothing is reported as changed unless the
  // server said so — a task that couldn't be found comes back in noSuchTask rather than silently.
  const noTargets = (t: Targets) =>
    JSON.stringify({
      error: "no task matched — pass the id(s) from the task list, or the exact titles",
      ...missedNames(t),
    });

  if (name === "complete_task") {
    const targets = await resolveTargets(args);
    if (targets.ids.length === 0) return noTargets(targets);
    const open = await getTasks("open");
    const results = await Promise.all(
      targets.ids.map(async (tid) => {
        const existing = open.find((t) => t.id === tid);
        // A repeating task is never "done": the server ticks the occurrence and keeps the row open, and
        // we move it on to its next date in the same request so the agenda is correct immediately.
        if (existing?.recurrence) {
          const next = nextOccurrence(existing.recurrence, existing.dueDate ?? localDateStr());
          return { id: tid, occurrence: true, task: await patchTask(tid, { status: "done", ...(next ? { dueDate: next } : {}) }) };
        }
        return { id: tid, occurrence: false, task: await patchTask(tid, { status: "done" }) };
      }),
    );
    const done = results.filter((r) => r.task);
    const missing = results.filter((r) => !r.task).map((r) => r.id);
    if (done.length === 0) return JSON.stringify({ error: "no such task", noSuchTask: missing, ...missedNames(targets) });
    onChanged?.();
    return JSON.stringify({
      ok: true,
      completed: done.map((r) => ({
        ...brief(r.task!),
        ...(r.occurrence ? { occurrenceDone: true, nextDue: r.task!.dueDate } : {}),
      })),
      ...(missing.length ? { noSuchTask: missing } : {}),
      ...missedNames(targets),
      ...(await remainingOpen()),
    });
  }

  if (name === "update_task") {
    const targets = await resolveTargets(args);
    if (targets.ids.length === 0) return noTargets(targets);
    const patch: {
      title?: string;
      dueDate?: string;
      dueTime?: string;
      recurrence?: string;
      status?: string;
    } = {};
    if (typeof args.title === "string") {
      // `title` renames, so it can only mean one task. Refusing beats quietly renaming five tasks to
      // the same thing — and the model most likely meant `titles` (which selects, not renames).
      if (targets.ids.length > 1) {
        return JSON.stringify({
          error:
            "title renames ONE task — pass a single id to rename, or use titles (not title) to choose which tasks to change",
        });
      }
      patch.title = args.title.trim();
    }
    if (typeof args.dueDate === "string") patch.dueDate = args.dueDate.trim(); // "" clears it
    if (typeof args.dueTime === "string") patch.dueTime = args.dueTime.trim();
    let anchorRepeat: string | undefined;
    if (typeof args.repeat === "string") {
      const repeat = args.repeat.trim(); // "" stops it repeating
      if (repeat && !isRecurring(repeat)) {
        return JSON.stringify({
          error:
            "unrecognised repeat schedule; use daily, weekdays, weekends, weekly:<days> or monthly:<day>",
        });
      }
      patch.recurrence = repeat;
      // Newly repeating with no date of its own — anchor it, or it can never come due.
      if (repeat && patch.dueDate === undefined) anchorRepeat = repeat;
    }
    const status = str(args.status);
    if (status === "open" || status === "dismissed") patch.status = status;
    const seeds = anchorRepeat ? await getTasks("open") : [];
    const results = await Promise.all(
      targets.ids.map(async (tid) => {
        const p = { ...patch };
        if (anchorRepeat) {
          const seed = seeds.find((t) => t.id === tid);
          if (seed && !seed.dueDate) p.dueDate = firstOccurrence(anchorRepeat) ?? undefined;
        }
        return { id: tid, task: await patchTask(tid, p) };
      }),
    );
    const updated = results.filter((r) => r.task);
    const missing = results.filter((r) => !r.task).map((r) => r.id);
    if (updated.length === 0) return JSON.stringify({ error: "no such task", noSuchTask: missing, ...missedNames(targets) });
    onChanged?.();
    return JSON.stringify({
      ok: true,
      updated: updated.map((r) => brief(r.task!)),
      ...(missing.length ? { noSuchTask: missing } : {}),
      ...missedNames(targets),
      // Only when the change moved tasks on or off the list — a reschedule/rename doesn't need it.
      ...(patch.status ? await remainingOpen() : {}),
    });
  }

  return JSON.stringify({ error: `unknown tool: ${name}` });
}
