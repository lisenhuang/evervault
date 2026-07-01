"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { htmlLang, type Lang, LANG_COOKIE } from "./config";
import en, { type Messages } from "./messages/en";
import zh from "./messages/zh";

const DICTS: Record<Lang, Messages> = { en, zh };

type LanguageContextValue = {
  /** Active display language. */
  lang: Lang;
  setLang: (lang: Lang) => void;
  toggle: () => void;
  /** Message dictionary for the active language (read as `t.sidebar.newChat`, etc.). */
  t: Messages;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

/** Persist an explicit choice in a cookie so the NEXT server render is already correct (no flash),
 *  and keep the <html lang> attribute in sync for a11y/CSS. */
function persist(lang: Lang) {
  document.cookie = `${LANG_COOKIE}=${lang}; path=/; max-age=31536000; samesite=lax`;
  document.documentElement.lang = htmlLang(lang);
}

/**
 * Holds the active language in React state, seeded from `initialLang` (resolved on the server from
 * the cookie / Accept-Language). Because SSR and the first client render use the same `initialLang`,
 * text hydrates without a mismatch or flash; switching afterwards is a pure state update (instant).
 */
export function LanguageProvider({ initialLang, children }: { initialLang: Lang; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    persist(next);
  }, []);
  const toggle = useCallback(() => setLang(lang === "zh" ? "en" : "zh"), [lang, setLang]);

  const value = useMemo<LanguageContextValue>(
    () => ({ lang, setLang, toggle, t: DICTS[lang] }),
    [lang, setLang, toggle],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLang(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLang must be used within <LanguageProvider>");
  return ctx;
}

/** Convenience for components that only need the strings: the active-language dictionary. */
export function useT(): Messages {
  return useLang().t;
}
