// Same-origin fetch helper for the /webapp end-user session. Cookies (ev_user) flow through nginx,
// so all calls are relative `/api/...`. NOTE: this only handles auth — the AI chat itself never
// goes through our server (the user's Gemini key calls Google directly from the browser).
export function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

// The spec caps the total body of all in-flight `keepalive` requests at 64 KB, and a request over
// the limit is REJECTED rather than downgraded — so it can't be set blindly. Stay well under it.
const KEEPALIVE_MAX_BYTES = 50_000;

/**
 * POST a JSON body, opting into `keepalive` only when the body is small enough to be allowed. Used by
 * the fire-and-forget memory writes, which are routinely kicked off from `pagehide` — without
 * `keepalive` the browser cancels them as the tab goes away and the turn is silently lost. Bodies
 * carrying base64 audio or a high-dimension embedding blow past the cap, so those degrade to a normal
 * request (no worse than before) instead of failing outright.
 */
export function postJsonBeacon(path: string, body: unknown): Promise<Response> {
  const json = JSON.stringify(body);
  const small = new Blob([json]).size <= KEEPALIVE_MAX_BYTES;
  return api(path, { method: "POST", body: json, ...(small ? { keepalive: true } : {}) });
}

export type Me = { email: string; name: string; picture: string | null };
export type AuthConfig = { enabled: boolean; clientId: string | null };
