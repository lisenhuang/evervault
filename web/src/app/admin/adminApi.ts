// Same-origin fetch helper for the admin UI. Cookies flow automatically through nginx,
// so all calls are relative `/api/...` (no base URL, no CORS, no token handling).
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
