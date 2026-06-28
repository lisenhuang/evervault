/**
 * Resolves the API base URL by execution context.
 *
 * - Browser (client components): same-origin, relative `/api`. In the published
 *   container the backend port (38372) is NOT exposed, and an absolute cross-port
 *   URL from a :38378 page would trip CORS. Relative `/api` goes through whatever
 *   served the page (nginx on :38378 in docker, the dev server locally).
 * - Server-side (server components / route handlers): straight to the backend.
 *   Inside the single container the backend is reachable on localhost:38372.
 *
 * Override either via env: NEXT_PUBLIC_API_BASE (browser) / API_BASE_URL (server).
 */
const SERVER_API_BASE = process.env.API_BASE_URL ?? "http://localhost:38372/api";
const BROWSER_API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "/api";

/** The API base URL for the current execution context. */
export function apiBase(): string {
  return typeof window === "undefined" ? SERVER_API_BASE : BROWSER_API_BASE;
}

/** Join the context-aware API base with a path, e.g. apiUrl("/health"). */
export function apiUrl(path: string): string {
  const base = apiBase();
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
