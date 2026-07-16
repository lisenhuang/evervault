// Keeps a chat reply alive across a mobile tab suspension.
//
// On iOS Safari (and other mobile browsers) switching to another app suspends the page and tears down any
// in-flight fetch/stream. The frozen request rejects with a transport-level "Load failed" the instant the
// user returns — which the app would otherwise surface as "the server is temporarily unreachable", even
// though nothing is wrong with the server. That's the exact scenario a user hits by firing a voice message
// and leaving the tab before the reply lands. The spoken-audio step already survives this (it's synthesized
// server-side and polled — see voiceReply.ts); this covers the reply *generation* itself, which still runs
// in the page and is what actually gets killed.

import { isNetworkError } from "./aiError";

/** Resolve as soon as the tab is (or becomes) foreground again. Resolves immediately when already visible. */
function whenForeground(): Promise<void> {
  if (typeof document === "undefined" || document.visibilityState === "visible") return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (document.visibilityState === "visible") {
        document.removeEventListener("visibilitychange", check);
        window.removeEventListener("pageshow", check);
        resolve();
      }
    };
    document.addEventListener("visibilitychange", check);
    window.addEventListener("pageshow", check);
  });
}

/**
 * Run a reply-generating async op, transparently retrying it across a tab suspension.
 *
 * When the op fails with a network error AND the tab was hidden at some point during that attempt, treat
 * it as a suspension kill rather than a real outage: wait for the tab to return to the foreground and run
 * the op again. A genuine network error while the tab stayed visible (or any non-network error) is
 * re-thrown unchanged, so the caller still shows its normal error. `maxRetries` bounds how many
 * suspensions we ride out before giving up — a safety net against a persistent failure that happens to
 * coincide with backgrounding.
 *
 * `run` is invoked afresh per attempt (and receives the 0-based attempt index), so it MUST rebuild any
 * state a previous attempt may have mutated — e.g. the Gemini `contents` array the tool loop appends to.
 */
export async function runWithSuspensionRetry<T>(
  run: (attempt: number) => Promise<T>,
  maxRetries = 4,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    // Was the tab hidden at any point during this attempt? Start from the current state (a request begun
    // while already backgrounded counts), then latch on any hide event that lands mid-flight.
    let sawHidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    const onVisibility = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") sawHidden = true;
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
    try {
      return await run(attempt);
    } catch (e) {
      // Only a suspension-shaped failure is retried: a network kill that coincided with the tab being
      // hidden, and only up to the cap. Everything else propagates to the caller's error handling.
      if (attempt >= maxRetries || !sawHidden || !isNetworkError(e)) throw e;
    } finally {
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    }
    await whenForeground();
  }
}
