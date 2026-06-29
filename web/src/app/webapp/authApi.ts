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

export type Me = { email: string; name: string; picture: string | null };
export type AuthConfig = { enabled: boolean; clientId: string | null };
