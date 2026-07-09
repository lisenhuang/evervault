// Structured task list — the thing that makes "what do I need to do today?" reliable. Unlike free-text
// chat memory (indexed by when it was said), a task has an explicit due date, so the agenda ("due today +
// overdue") is a deterministic block injected into every chat rather than a semantic guess. Tasks are
// extracted in the browser (the user's own Gemini key) or created by the in-chat task tools; the server
// only stores and serves them. All writes are fire-and-forget and must never block the chat.

import { api } from "../authApi";

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
};

export type TaskDelta = {
  adds?: { title: string; details?: string; dueDate?: string; dueTime?: string }[];
  completes?: number[];
  dismisses?: number[];
};

// --- API helpers (same-origin; the user's key never leaves the browser) ---

export async function getTasks(status = "open", take = 100): Promise<Task[]> {
  try {
    const res = await api(`/api/chat/tasks?status=${encodeURIComponent(status)}&take=${take}`);
    if (res.ok) return (await res.json()) as Task[];
  } catch {
    /* ignore */
  }
  return [];
}

export async function createTask(
  t: { title: string; details?: string; dueDate?: string; dueTime?: string; conversationId?: string },
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
  patch: { title?: string; details?: string; dueDate?: string; dueTime?: string; status?: string },
): Promise<Task | null> {
  try {
    const res = await api(`/api/chat/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
    if (res.ok) return (await res.json()) as Task;
  } catch {
    /* ignore */
  }
  return null;
}

/** Apply an extraction delta. Fire-and-forget, like syncProfile. */
export function syncTasks(delta: TaskDelta, conversationId: string): void {
  if (!delta.adds?.length && !delta.completes?.length && !delta.dismisses?.length) return;
  void api("/api/chat/tasks/sync", {
    method: "POST",
    body: JSON.stringify({ ...delta, conversationId }),
  }).catch(() => {});
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

/** Local "YYYY-MM-DD" for the given date. Built by hand rather than via toISOString(), which would
 * shift into UTC and land on the wrong day near midnight for non-UTC users. */
export function localDateStr(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
export function renderAgendaBlock(tasks: Task[], now = new Date()): string | null {
  const open = tasks.filter((t) => t.status === "open");
  if (open.length === 0) return null;
  const today = localDateStr(now);

  const overdue = open
    .filter((t) => t.dueDate && t.dueDate < today)
    .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : 1));
  const dueToday = open.filter((t) => t.dueDate === today);
  const undated = open
    .filter((t) => !t.dueDate)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const line = (t: Task, suffix = "") => `- [#${t.id}] ${t.title}${t.dueTime ? ` at ${t.dueTime}` : ""}${suffix}`;
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
  if (lines.length === 0) return null;

  return (
    "The user's task list (structured, authoritative — this is the ground truth for what they need to " +
    "do; prefer it over conversational memory when they ask what's on their plate, and never invent " +
    "tasks that aren't listed here or returned by list_tasks). Refer to tasks by their title, not their " +
    "id number:\n" +
    lines.join("\n")
  );
}
