"use client";

import { Languages } from "lucide-react";
import { useLang } from "./LanguageProvider";
import { LANGS } from "./config";

/**
 * Language switcher (English ↔ 简体中文). Mirrors ThemeToggle. Two shapes:
 * - `variant="button"` — a compact icon button (landing header) that toggles the language.
 * - `variant="row"` — a segmented control [ English | 中文 ] for the Sidebar settings row.
 * The language is known on the server (cookie / Accept-Language), so — unlike the theme toggle —
 * there's no need to gate on a `mounted` flag: SSR and first client render already agree.
 */
export default function LanguageToggle({ variant = "button" }: { variant?: "button" | "row" }) {
  const { lang, setLang, toggle, t } = useLang();

  if (variant === "row") {
    return (
      <div className="inline-flex items-center gap-0.5 rounded-lg bg-black/5 p-0.5 dark:bg-white/10">
        {LANGS.map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => setLang(l)}
            aria-pressed={lang === l}
            className={`rounded-md px-2 py-1 text-xs font-medium transition ${
              lang === l
                ? "bg-white text-black shadow-sm dark:bg-neutral-700 dark:text-white"
                : "text-black/50 hover:text-black/80 dark:text-white/50 dark:hover:text-white/80"
            }`}
          >
            {l === "en" ? t.language.en : t.language.zh}
          </button>
        ))}
      </div>
    );
  }

  const target = lang === "zh" ? t.language.switchToEn : t.language.switchToZh;
  return (
    <button
      type="button"
      onClick={toggle}
      className="inline-flex items-center gap-1.5 rounded-md p-2 text-black/60 transition hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
      title={target}
      aria-label={target}
    >
      <Languages size={18} aria-hidden="true" />
      <span className="text-xs font-medium">{lang === "en" ? "EN" : "中"}</span>
    </button>
  );
}
