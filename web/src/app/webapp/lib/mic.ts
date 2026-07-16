// Microphone acquisition, shared by the voice-message recorder (audio.ts) and the live-call
// streamer (liveAudio.ts). getUserMedia can fail for very different reasons — the browser doesn't
// expose it at all (in-app webviews), the page isn't a secure context, the user (or a persisted
// setting) denied it, there's no mic, or another app holds it. The old code treated every one of
// these as "access was blocked", which is misleading when there's no prompt to allow in the first
// place. Classifying the failure lets each caller show an accurate, actionable message.

export type MicErrorReason =
  | "insecure" // page isn't a secure (https) context, so the mic API is unavailable
  | "unsupported" // browser/webview doesn't expose getUserMedia (common in in-app browsers)
  | "denied" // permission refused — by the prompt, or a persisted per-site block
  | "notfound" // no microphone hardware
  | "inuse" // mic is held by another app / not readable
  | "unknown";

/** A getUserMedia failure classified into one of {@link MicErrorReason}. `reason` drives the message. */
export class MicError extends Error {
  readonly reason: MicErrorReason;
  constructor(reason: MicErrorReason, cause?: unknown) {
    super(`microphone unavailable: ${reason}`);
    this.name = "MicError";
    this.reason = reason;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** True when `e` is (or looks like) a {@link MicError} — duck-typed so a re-bundled copy still matches. */
export function isMicError(e: unknown): e is MicError {
  return e instanceof MicError || (e as { name?: unknown } | null)?.name === "MicError";
}

/** Why the mic can't even be requested yet, before touching getUserMedia. */
function micSupport(): "ok" | "insecure" | "unsupported" {
  if (typeof navigator === "undefined") return "unsupported";
  // getUserMedia is only exposed in a secure context. localhost counts as secure, so dev is fine.
  if (typeof window !== "undefined" && window.isSecureContext === false) return "insecure";
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
    return "unsupported";
  }
  return "ok";
}

/** Map a rejected getUserMedia error (a DOMException, usually) to a {@link MicErrorReason}. */
function classifyGetUserMediaError(e: unknown): MicErrorReason {
  const name = (e as { name?: unknown } | null)?.name;
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError": // legacy alias some engines still throw
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "notfound";
    case "NotReadableError":
    case "AbortError":
      return "inuse";
    case "TypeError": // mediaDevices/getUserMedia missing — treat as unsupported
      return "unsupported";
    default:
      return "unknown";
  }
}

/**
 * Acquire the microphone, throwing a typed {@link MicError} on any failure so callers can show an
 * accurate message. Checks support/secure-context first (so an in-app browser reports "unsupported"
 * rather than a bogus "blocked"), then requests the stream and classifies whatever getUserMedia
 * rejects with. Call it as the first `await` inside a user gesture — iOS drops the mic request if a
 * different async step runs before it.
 */
export async function acquireMicStream(constraints: MediaStreamConstraints): Promise<MediaStream> {
  const support = micSupport();
  if (support !== "ok") throw new MicError(support === "insecure" ? "insecure" : "unsupported");
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    throw new MicError(classifyGetUserMediaError(e), e);
  }
}
