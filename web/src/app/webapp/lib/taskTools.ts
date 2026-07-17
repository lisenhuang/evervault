// The task tools — let the model read and manage the user's structured task list from inside a chat.
// Shared by the text chat (gemini.ts) and the realtime voice call (liveSession.ts) so both surfaces
// expose the same capability. Reuses the /api/chat/tasks endpoints; no new network code. The injected
// agenda block (renderAgendaBlock) already shows today's + overdue tasks; these tools cover the rest:
// looking further out, and adding/completing/rescheduling on the fly.

import { Type, type FunctionDeclaration } from "@google/genai";
import { createTask, getTasks, patchTask, type Task } from "./tasks";

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
  "added. Once they confirm, resolve relative dates ('tomorrow', 'next Friday') into a YYYY-MM-DD date, and " +
  "omit the date if they didn't give one. When the user says something is done, " +
  "call complete_task with its id; use update_task to reschedule a task or to dismiss one they no longer " +
  "want (dismiss, don't complete, when it wasn't actually done). Refer to tasks by their title, never by " +
  "id number, and never invent tasks that aren't on the list.";

export const LIST_TASKS_DECLARATION: FunctionDeclaration = {
  name: "list_tasks",
  description:
    "List the user's tasks. Use for 'what do I need to do', 'what's due this week', or to look up a " +
    "task's id before completing or updating it. Defaults to open tasks.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      status: {
        type: Type.STRING,
        description: "Which tasks to return: 'open' (default), 'done', 'dismissed', or 'all'.",
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
    },
    required: ["title"],
  },
};

export const COMPLETE_TASK_DECLARATION: FunctionDeclaration = {
  name: "complete_task",
  description: "Mark a task done when the user says they finished it. Use the id from the task list or list_tasks.",
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

const brief = (t: Task) => ({
  id: t.id,
  title: t.title.length > 200 ? t.title.slice(0, 200) + "…" : t.title,
  due: t.dueDate,
  time: t.dueTime,
  status: t.status,
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
): Promise<string> {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const id = Number(args.id);

  if (name === "list_tasks") {
    const status = str(args.status) ?? "open";
    const cutoff = str(args.dueOnOrBefore);
    const includeUndated = args.includeUndated !== false;
    let tasks = await getTasks(["open", "done", "dismissed", "all"].includes(status) ? status : "open");
    if (cutoff) tasks = tasks.filter((t) => (t.dueDate ? t.dueDate <= cutoff : includeUndated));
    if (tasks.length === 0) return JSON.stringify({ tasks: [], note: "no matching tasks" });
    return JSON.stringify({ tasks: tasks.slice(0, 50).map(brief) });
  }

  if (name === "add_task") {
    const title = str(args.title);
    if (!title) return JSON.stringify({ error: "a title is required" });
    const task = await createTask(
      { title, details: str(args.details), dueDate: str(args.dueDate), dueTime: str(args.dueTime) },
      "ai",
    );
    if (!task) return JSON.stringify({ error: "could not add the task" });
    onChanged?.();
    return JSON.stringify({ ok: true, task: brief(task) });
  }

  if (name === "complete_task") {
    if (!Number.isFinite(id)) return JSON.stringify({ error: "a task id is required" });
    const task = await patchTask(id, { status: "done" });
    if (!task) return JSON.stringify({ error: "no such task" });
    onChanged?.();
    return JSON.stringify({ ok: true, task: brief(task) });
  }

  if (name === "update_task") {
    if (!Number.isFinite(id)) return JSON.stringify({ error: "a task id is required" });
    const patch: { title?: string; dueDate?: string; dueTime?: string; status?: string } = {};
    if (typeof args.title === "string") patch.title = args.title.trim();
    if (typeof args.dueDate === "string") patch.dueDate = args.dueDate.trim(); // "" clears it
    if (typeof args.dueTime === "string") patch.dueTime = args.dueTime.trim();
    const status = str(args.status);
    if (status === "open" || status === "dismissed") patch.status = status;
    const task = await patchTask(id, patch);
    if (!task) return JSON.stringify({ error: "no such task" });
    onChanged?.();
    return JSON.stringify({ ok: true, task: brief(task) });
  }

  return JSON.stringify({ error: `unknown tool: ${name}` });
}
