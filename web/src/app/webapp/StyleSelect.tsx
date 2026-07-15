"use client";

import { useT } from "@/i18n/LanguageProvider";
import { RESPONSE_STYLES, type ResponseStyle } from "./lib/responseStyle";

/**
 * Compact pill picker for a response-style preset. There are only a handful of options, so a
 * wrap of toggle buttons reads more clearly (and stays fully keyboard/tap accessible) than a
 * dropdown. The selected pill is highlighted; "default" is always offered first as the
 * leave-it-alone choice. Used three times in the settings drawer (text / voice / live).
 */
export default function StyleSelect({
  value,
  onChange,
  ariaLabel,
}: {
  value: ResponseStyle;
  onChange: (v: ResponseStyle) => void;
  ariaLabel: string;
}) {
  const t = useT();
  const label = (s: ResponseStyle) => t.settings.styles[s];

  return (
    <div role="radiogroup" aria-label={ariaLabel} className="mt-2 flex flex-wrap gap-1.5">
      {RESPONSE_STYLES.map((s) => {
        const isSel = s === value;
        return (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={isSel}
            onClick={() => onChange(s)}
            className={`rounded-full border px-3 py-1.5 text-sm transition ${
              isSel
                ? "border-blue-500 bg-blue-500 text-white shadow-sm"
                : "border-black/15 text-black/70 hover:bg-black/5 dark:border-white/20 dark:text-white/70 dark:hover:bg-white/10"
            }`}
          >
            {label(s)}
          </button>
        );
      })}
    </div>
  );
}
