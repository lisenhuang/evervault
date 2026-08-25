// The deck's active language, as a context rather than a prop.
//
// The slides are plain JSX in a module-level array, so threading a `lang` prop down to every
// diagram would mean touching all 25 of them for something none of them care about. A context lets
// the six SVG diagrams pick their own labels while the slide array stays a flat, readable list.
//
// The default is English deliberately: a diagram rendered outside the provider — a thumbnail, a
// test, anything added later — comes out in English rather than throwing or coming out blank.
//
// Note that this is NOT the site's i18n (src/i18n). That one persists a cookie and resolves from
// Accept-Language, because the site should stay in the language a visitor chose. This one is the
// opposite by design: it is a reading aid that always starts in English, so the deck a presenter
// opens is the deck the audience will see. See Deck.tsx for where that is enforced.

"use client";

import { createContext, useContext } from "react";

export type DeckLang = "en" | "zh";

export const DeckLangContext = createContext<DeckLang>("en");

/**
 * Returns a picker for the active language: `l("Postgres", "数据库")`. Used inside the diagrams,
 * where labels are short enough that a pair of literals at the point of use stays far more readable
 * than a key into a dictionary somewhere else in the file.
 */
export function useDeckLabel(): (en: string, zh: string) => string {
  const lang = useContext(DeckLangContext);
  return (en, zh) => (lang === "zh" ? zh : en);
}

export function useDeckLang(): DeckLang {
  return useContext(DeckLangContext);
}
