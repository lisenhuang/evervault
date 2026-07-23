// Best-effort delivery of client-captured error reports to POST /api/chat/errors, so the reference
// code shown to the user is searchable in /admin/errors. The interesting failures are exactly the
// ones where the server is unreachable, so undeliverable reports queue in localStorage and re-flush
// later (next report, connectivity return, next page load).
import { api } from "../authApi";
import type { FriendlyAiError } from "./aiError";

type QueuedReport = {
  code: string;
  area: string;
  httpStatus?: number;
  message?: string;
  detail?: string;
};

const QUEUE_KEY = "ev_error_queue";
const MAX_QUEUE = 20;

function readQueue(): QueuedReport[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as QueuedReport[]).filter((r) => r && typeof r.code === "string") : [];
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedReport[]) {
  try {
    if (queue.length === 0) localStorage.removeItem(QUEUE_KEY);
    else localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE)));
  } catch {
    /* storage full/blocked — the report is lost, but the code was still shown and logged nowhere else */
  }
}

// Statuses that mean "retrying could still succeed", so the report stays queued: a network failure,
// any 5xx, or the transient 4xx we can hit here — 429 (our own hourly rate limit resets), 401 (the
// session can be renewed), 403 (an edge WAF blip), and 404 (a new client hitting a backend that
// hasn't rolled out /api/chat/errors yet). Only a genuine "this body will never be accepted" 4xx
// (400/413/422) is a permanent drop.
function isPermanentReject(status: number): boolean {
  if (status === 429 || status === 401 || status === 403 || status === 404) return false;
  return status >= 400 && status < 500;
}

/** True when the report reached the server, or was rejected for good (don't retry). False → keep queued. */
async function deliver(report: QueuedReport): Promise<boolean> {
  try {
    const res = await api("/api/chat/errors", { method: "POST", body: JSON.stringify(report) });
    return res.ok || isPermanentReject(res.status);
  } catch {
    return false; // network-level failure (origin down) — keep it queued
  }
}

let flushing = false;

/** Try to send everything queued; whatever still fails stays queued for next time. */
export async function flushErrorReports(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    // Drain the whole queue, re-reading it each pass. A report enqueued by reportAiError() while a
    // deliver() was in flight no-ops its own flush (the `flushing` guard), so this run must pick it up
    // rather than leaving it parked until the next trigger — otherwise a long-lived tab that never
    // reloads can sit on a shown code indefinitely. Re-reading also avoids clobbering with a stale
    // snapshot. Stops as soon as a deliver() fails (server still unreachable) or the queue is empty.
    for (;;) {
      const queue = readQueue();
      if (queue.length === 0) break;
      let failed = false;
      for (const report of queue) {
        if (!(await deliver(report))) {
          failed = true; // server still unreachable — stop, keep this and the rest queued
          break;
        }
        writeQueue(readQueue().filter((r) => r.code !== report.code));
      }
      if (failed) break;
      // A full pass landed — loop once more to catch any report enqueued mid-flush; an empty queue ends it.
    }
  } finally {
    flushing = false;
  }
}

/** Drop any queued reports — call on sign-out so a later account can't flush the previous user's queue. */
export function clearErrorReportQueue(): void {
  writeQueue([]);
}

/**
 * Queue + send one error report. Backend-minted codes are skipped (the server already stored that
 * report when it built the response); a queued backlog is flushed alongside the new report.
 */
export function reportAiError(err: FriendlyAiError, area: string): void {
  if (!err.fromBackend) {
    const queue = readQueue().filter((r) => r.code !== err.code);
    queue.push({
      code: err.code,
      area,
      httpStatus: err.status,
      message: err.text.split("\n")[0]?.slice(0, 500),
      detail: err.detail.slice(0, 6000),
    });
    writeQueue(queue);
  }
  void flushErrorReports();
}

// Re-flush when connectivity returns or on the next page load with a leftover backlog.
if (typeof window !== "undefined") {
  window.addEventListener("online", () => void flushErrorReports());
  if (readQueue().length > 0) void flushErrorReports();
}
