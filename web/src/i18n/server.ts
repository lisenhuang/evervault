// Server-side initial-language resolution. Imported only by server components (the root layout).
// Reads the persisted cookie first, then falls back to the request's Accept-Language header. Note:
// touching cookies()/headers() opts routes into dynamic rendering — acceptable here (the app is
// already dynamic for auth), and required so server-rendered pages (the landing page) come out in
// the correct language with no flash.

import { cookies, headers } from "next/headers";
import { type Lang, LANG_COOKIE, parseAcceptLanguage, pickLang } from "./config";

export async function getServerLang(): Promise<Lang> {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const stored = cookieStore.get(LANG_COOKIE)?.value;
  const locales = parseAcceptLanguage(headerStore.get("accept-language"));
  return pickLang(stored, locales);
}
