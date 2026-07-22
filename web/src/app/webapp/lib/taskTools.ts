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
  "list on your own initiative or just because a to-do came up in conversation. When the user mentions a " +
  "concrete to-do, appointment, or deadline, first ASK whether they want it added to their task list, and " +
  "only call add_task AFTER they explicitly confirm — the human must approve every task before it is " +
  "added. The one exception is when the user has ALREADY asked you to remember or remind them of " +
  "something (\"remind me to X\", \"don't let me forget X\") — that IS the confirmation, so just add it " +
  "and say you've got it, rather than asking them to confirm a request they already made. " +
  "Once they confirm, resolve relative dates ('tomorrow', 'next Friday') into a YYYY-MM-DD date, and " +
  "omit the date if they didn't give one. When the user says something is done, " +
  "call complete_task with its id; use update_task to reschedule a task or to dismiss one they no longer " +
  "want (dismiss, don't complete, when it wasn't actually done). Refer to tasks by their title, never by " +
  "id number, and never invent tasks that aren't on the list. " +
  "If the user says they don't recognise a task you raised, do NOT apologise it away, claim you made it " +
  "up, or tell them to ignore it — the task list shown to you is authoritative. Check it (use list_tasks " +
  "to look it up by name), and if it really is on the list, say so plainly, tell them where it came from " +
  "and when if you have that (you may be shown it was one you added from an earlier chat, one auto-noted " +
  "from a past conversation, or one they added themselves), and offer to remove, reschedule, or keep it. " +
  "Only treat a task as non-existent if it genuinely isn't on the list or returned by list_tasks.\n\n" +
  // Without this the whole reminder feature is invisible: the agenda is passive context, so the model
  // reads it and says nothing, and the user has to ask "what's on my list" to ever be reminded.
  "BRING UP WHAT'S DUE. A reminder is only useful if you actually raise it. When a conversation starts " +
  "and something is overdue or due today, mention it yourself, early and briefly, without waiting to be " +
  "asked — warmly and in one line, not as a recited list (\"Morning! Just so you know, cleaning the room " +
  "is on for today.\"). Raise a given task only once per conversation; if they've already told you they " +
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
    "task's id before completing or updating it, or to look up a specific task BY NAME (pass query) " +
    "when the user asks about or disputes one. Results include each task's origin (where/when it came " +
    "from). Defaults to open tasks.",
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
    "Add a new task to the user's list. Only call this AFTER the user has explicitly confirmed they want " +
    "the task added — never add a task without first asking and getting their go-ahead.",
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

export const COMPLETE_TASK_DECLARATION: FunctionDeclaration = {
  name: "complete_task",
  description:
    "Mark a task done when the user says they finished it. Use the id from the task list or " +
    "list_tasks. For a repeating task this completes THIS occurrence and automatically schedules the " +
    "next one — the response tells you the next date — so don't describe it as finished for good.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      id: { type: Type.INTEGER, description: "The task's id (shown as [#id] in the task list)." },
    },
    required: ["id"],
  },
};

export const UPDATE_TASK_DECLARATION: FunctionDeclaration = {
  name: "update_task",
  description:
    "Reschedule, edit, or dismiss a task. Use to change its date/title, or to dismiss one the user no " +
    "longer wants (dismiss rather than complete when it wasn't actually done).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      id: { type: Type.INTEGER, description: "The task's id (shown as [#id] in the task list)." },
      title: { type: Type.STRING, description: "New title." },
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
    required: ["id"],
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
  const id = Number(args.id);

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

  if (name === "complete_task") {
    if (!Number.isFinite(id)) return JSON.stringify({ error: "a task id is required" });
    const existing = (await getTasks("open")).find((t) => t.id === id);
    // A repeating task is never "done": the server ticks the occurrence and keeps the row open, and we
    // move it on to its next date in the same request so the agenda is correct immediately.
    if (existing?.recurrence) {
      const next = nextOccurrence(existing.recurrence, existing.dueDate ?? localDateStr());
      const task = await patchTask(id, { status: "done", ...(next ? { dueDate: next } : {}) });
      if (!task) return JSON.stringify({ error: "no such task" });
      onChanged?.();
      return JSON.stringify({
        ok: true,
        occurrenceDone: true,
        nextDue: task.dueDate,
        task: brief(task),
      });
    }
    const task = await patchTask(id, { status: "done" });
    if (!task) return JSON.stringify({ error: "no such task" });
    onChanged?.();
    return JSON.stringify({ ok: true, task: brief(task) });
  }

  if (name === "update_task") {
    if (!Number.isFinite(id)) return JSON.stringify({ error: "a task id is required" });
    const patch: {
      title?: string;
      dueDate?: string;
      dueTime?: string;
      recurrence?: string;
      status?: string;
    } = {};
    if (typeof args.title === "string") patch.title = args.title.trim();
    if (typeof args.dueDate === "string") patch.dueDate = args.dueDate.trim(); // "" clears it
    if (typeof args.dueTime === "string") patch.dueTime = args.dueTime.trim();
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
      if (repeat && patch.dueDate === undefined) {
        const seed = (await getTasks("open")).find((t) => t.id === id);
        if (seed && !seed.dueDate) patch.dueDate = firstOccurrence(repeat) ?? undefined;
      }
    }
    const status = str(args.status);
    if (status === "open" || status === "dismissed") patch.status = status;
    const task = await patchTask(id, patch);
    if (!task) return JSON.stringify({ error: "no such task" });
    onChanged?.();
    return JSON.stringify({ ok: true, task: brief(task) });
  }

  return JSON.stringify({ error: `unknown tool: ${name}` });
}
