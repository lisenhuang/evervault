// Turns an AI/proxy failure into a short localized message plus a reference code — the only two
// things an end user ever sees. The raw error body (which can be a whole Cloudflare/nginx HTML 502
// page, or provider JSON) never reaches the bubble; it goes into `detail` for the error report an
// admin can look up by code in /admin/errors.
import type { Messages } from "@/i18n/messages/en";

export type FriendlyAiError = {
  /** Localized message + reference code — safe to render. */
  text: string;
  /** "EV-XXXXXXXX" — the backend's referenceCode when it sent one, else minted here. */
  code: string;
  /** True when the backend already stored this report (the client must not re-report it). */
  fromBackend: boolean;
  /** HTTP status when known. */
  status?: number;
  /** Raw (clipped) error for the report — never rendered. */
  detail: string;
};

// Same Crockford-style alphabet as the backend's ErrorReportService — no 0/1/I/L/O/U.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_SHAPE = /^EV-[A-Z0-9]{4,16}$/;

// A network-level failure (origin unreachable before any HTTP response) surfaces as a TypeError whose
// message is browser-specific English. On iOS Safari a tab suspension produces the very same thing:
// backgrounding the app tears down the in-flight request, which rejects with "Load failed" the moment
// the page resumes. Shared by friendlyAiError (to classify it as "unreachable") and isNetworkError.
const NETWORK_ERROR_RE =
  /failed to fetch|networkerror|load failed|network request failed|the network connection was lost/i;

/**
 * True when `e` is a transport-level failure — a network TypeError with no HTTP response behind it
 * (origin down, connection dropped, or an iOS tab-suspension kill). Distinguished from a real HTTP
 * error, which always carries a numeric status. Callers use this to tell a retryable suspension kill
 * apart from a genuine server error.
 */
export function isNetworkError(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status !== 0) return false; // a real HTTP response came back
  const raw = e instanceof Error ? e.message : String(e ?? "");
  return NETWORK_ERROR_RE.test(raw);
}

export function newErrorCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `EV-${s}`;
}

type Parsed = { message: string; status?: number; statusText?: string; referenceCode?: string };

// The @google/genai SDK stringifies error bodies into Error.message in two shapes:
//  - non-JSON body (gateway HTML): {"error":{"message":"<!DOCTYPE html>…","code":502,"status":""}}
//  - JSON body (our backend / real Gemini errors): {"error":"…","referenceCode":"EV-…"} or
//    {"error":{"message":"…","code":429,"status":"RESOURCE_EXHAUSTED"}}
function parseErrorBody(raw: string): Parsed {
  try {
    const body = JSON.parse(raw) as { error?: unknown; referenceCode?: unknown };
    const refCode = typeof body.referenceCode === "string" ? body.referenceCode : undefined;
    if (typeof body.error === "string") return { message: body.error, referenceCode: refCode };
    if (body.error && typeof body.error === "object") {
      const err = body.error as { message?: unknown; code?: unknown; status?: unknown; referenceCode?: unknown };
      return {
        message: typeof err.message === "string" ? err.message : "",
        status: typeof err.code === "number" ? err.code : undefined,
        statusText: typeof err.status === "string" ? err.status : undefined,
        referenceCode: refCode ?? (typeof err.referenceCode === "string" ? err.referenceCode : undefined),
      };
    }
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return { message: raw };
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function friendlyAiError(e: unknown, t: Messages): FriendlyAiError {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  let parsed = parseErrorBody(raw);
  // Defensive second level: some wrappers double-encode the body into `message`.
  if (parsed.message.startsWith("{")) {
    const inner = parseErrorBody(parsed.message);
    parsed = { ...inner, status: inner.status ?? parsed.status, referenceCode: inner.referenceCode ?? parsed.referenceCode };
  }

  // ApiError carries the HTTP status as a property; duck-typed so a duplicated SDK module can't
  // break an instanceof check.
  const propStatus = (e as { status?: unknown } | null)?.status;
  const status = parsed.status ?? (typeof propStatus === "number" ? propStatus : undefined);

  const looksHtml = /<!doctype html|<html[\s>]/i.test(parsed.message.slice(0, 500));
  // A network-level failure (origin down before any HTTP response) surfaces as a TypeError whose
  // message is browser-specific English ("Failed to fetch" / "Load failed" / "NetworkError…") — treat
  // it as unreachable, not as text to show.
  const networkError = status === undefined && NETWORK_ERROR_RE.test(raw);
  const busy =
    status === 429 || /resource_exhausted/i.test(raw) || parsed.statusText === "RESOURCE_EXHAUSTED";
  const gateway =
    status === 502 || status === 503 || status === 504 || (status !== undefined && status >= 520 && status <= 530);

  let friendly: string;
  if (busy) friendly = t.chat.aiBusy;
  else if (gateway || looksHtml || networkError) friendly = t.chat.aiUnreachable;
  // Never surface raw provider/gateway text to the end user — the real message goes only into the
  // report's `detail`, searchable by code in the admin panel. Everything else is the generic line.
  else friendly = t.chat.aiFailedGeneric;

  const backendCode = (parsed.referenceCode ?? "").trim().toUpperCase();
  const fromBackend = CODE_SHAPE.test(backendCode);
  const code = fromBackend ? backendCode : newErrorCode();

  return {
    // errorCodeLabel carries its own separator (localized colon), so this reads correctly in every language.
    text: `${friendly}\n\n${t.chat.errorCodeLabel}${code}`,
    code,
    fromBackend,
    status,
    detail: clip(raw, 6000),
  };
}
