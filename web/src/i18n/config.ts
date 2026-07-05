// Shared, framework-agnostic i18n core: the supported display languages, the cookie that
// persists an explicit choice, and the pure locale resolver used on both the server (from the
// Accept-Language header) and the client. Chinese is only displayed as Simplified — a
// Traditional-Chinese system locale (zh-TW / zh-HK / zh-Hant) falls back to Simplified Chinese.

export type Lang = "en" | "zh" | "ko" | "ja";

export const LANGS: readonly Lang[] = ["en", "zh", "ko", "ja"];
export const DEFAULT_LANG: Lang = "en";

/** Native display name for each language, shown in the language menu. To add a language, extend
 *  `Lang` + `LANGS` + `LANG_LABELS` + `LANG_SHORT` and add its message dictionary — the menu picks
 *  it up automatically (no toggle logic to update). */
export const LANG_LABELS: Record<Lang, string> = {
  en: "English",
  zh: "中文",
  ko: "한국어",
  ja: "日本語",
};

/** Short badge shown on the compact (landing-header) language trigger. */
export const LANG_SHORT: Record<Lang, string> = {
  en: "EN",
  zh: "中",
  ko: "한",
  ja: "日",
};

/** Cookie name for the persisted language choice — readable on both server and client. */
export const LANG_COOKIE = "ev:lang";

export function isLang(v: unknown): v is Lang {
  return typeof v === "string" && (LANGS as readonly string[]).includes(v);
}

/**
 * Resolve the display language. An explicit stored choice always wins. Otherwise the first
 * system/browser locale that matches a supported language decides: any Chinese locale — including
 * Traditional (zh-TW / zh-HK / zh-Hant) — maps to Simplified Chinese, Korean to "ko", Japanese to
 * "ja"; everything else falls back to English.
 */
export function pickLang(stored: string | undefined | null, locales: readonly string[]): Lang {
  if (isLang(stored)) return stored;
  for (const l of locales) {
    const tag = l.toLowerCase();
    if (tag.startsWith("zh")) return "zh";
    if (tag.startsWith("ko")) return "ko";
    if (tag.startsWith("ja")) return "ja";
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
  return lang === "zh" ? "zh-Hans" : lang;
}

/**
 * System-instruction fragment that steers the assistant's reply language. Empty for English (the
 * model naturally mirrors the user); forces the selected language otherwise. Injected into the text
 * chat + live-voice system instructions so the AI answers in the selected display language.
 */
const AI_REPLY_DIRECTIVES: Record<Lang, string> = {
  en: "",
  zh: "Always reply in Simplified Chinese (简体中文), regardless of the language the user writes or speaks in.",
  ko: "Always reply in Korean (한국어), regardless of the language the user writes or speaks in.",
  ja: "Always reply in Japanese (日本語), regardless of the language the user writes or speaks in.",
};

export function aiReplyDirective(lang: Lang): string {
  return AI_REPLY_DIRECTIVES[lang];
}
