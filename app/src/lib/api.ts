// Authenticated fetch to the backend. Adds the bearer session token and resolves paths against
// API_BASE (which already includes "/api"). Ported webapp modules can pass either "/chat/…" or the
// legacy "/api/chat/…" — the leading "/api" is stripped so their code carries over almost verbatim.

import { API_BASE } from "@/config";
import { clearToken, getToken } from "./session";

export type ApiError = Error & { status: number };

function resolve(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  let p = path.startsWith("/") ? path : `/${path}`;
  if (p.startsWith("/api/")) p = p.slice(4); // "/api/chat/x" → "/chat/x"
  return API_BASE + p;
}

/** Low-level authed fetch. Never throws on non-2xx — the caller inspects `res.ok`. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((init.headers as Record<string, string>) ?? {}),
  };
  return fetch(resolve(path), { ...init, headers });
}

/** Authed JSON call that throws an {@link ApiError} on non-2xx (and clears the session on 401). */
export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    if (res.status === 401) await clearToken();
    let message = `Request failed (HTTP ${res.status}).`;
    try {
      const d = await res.json();
      if (d?.error) message = d.error;
    } catch {
      /* non-JSON body */
    }
    throw Object.assign(new Error(message), { status: res.status }) as ApiError;
  }
  return (await res.json()) as T;
}
