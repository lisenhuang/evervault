// Shared, framework-agnostic i18n core: the two supported display languages, the cookie that
// persists an explicit choice, and the pure locale resolver used on both the server (from the
// Accept-Language header) and the client. Only English and Simplified Chinese are ever displayed —
// a Traditional-Chinese system locale (zh-TW / zh-HK / zh-Hant) falls back to Simplified Chinese.

export type Lang = "en" | "zh";

export const LANGS: readonly Lang[] = ["en", "zh"];
export const DEFAULT_LANG: Lang = "en";

/** Cookie name for the persisted language choice — readable on both server and client. */
export const LANG_COOKIE = "ev:lang";

export function isLang(v: unknown): v is Lang {
  return v === "en" || v === "zh";
}

/**
 * Resolve the display language. An explicit stored choice ("en"/"zh") always wins. Otherwise any
 * Chinese system/browser locale — including Traditional (zh-TW / zh-HK / zh-Hant) — maps to
 * Simplified Chinese; everything else falls back to English.
 */
export function pickLang(stored: string | undefined | null, locales: readonly string[]): Lang {
  if (isLang(stored)) return stored;
  for (const l of locales) {
    if (l.toLowerCase().startsWith("zh")) return "zh";
  }
  return DEFAULT_LANG;
}

/** Parse an Accept-Language header into an ordered list of locale tags (q-weights applied, stripped). */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.find((p) => p.trim().startsWith("q="));
      const weight = q ? Number.parseFloat(q.split("=")[1]) : 1;
      return { tag: tag.trim(), weight: Number.isFinite(weight) ? weight : 1 };
    })
    .filter((x) => x.tag)
    .sort((a, b) => b.weight - a.weight)
    .map((x) => x.tag);
}

/** BCP-47 value for the <html lang> attribute. */
export function htmlLang(lang: Lang): string {
  return lang === "zh" ? "zh-Hans" : "en";
}

/**
 * System-instruction fragment that steers the assistant's reply language. Empty for English (the
 * model naturally mirrors the user); forces Simplified Chinese otherwise. Injected into the text
 * chat + live-voice system instructions so the AI answers in the selected display language.
 */
export function aiReplyDirective(lang: Lang): string {
  return lang === "zh"
    ? "Always reply in Simplified Chinese (简体中文), regardless of the language the user writes or speaks in."
    : "";
}
