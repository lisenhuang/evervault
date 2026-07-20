"use client";

import { CHAT_SCALE_STEPS, DEFAULT_CHAT_SCALE } from "./lib/store";
import { useT } from "@/i18n/LanguageProvider";

/**
 * Chat text-size stepper for the mobile header: two round A− / A+ discs flanking a rectangular
 * pill that shows the current percentage and resets to 100% when tapped. Shape carries the
 * meaning — circles act, the rectangle reads out. It scales the conversation only (see the
 * `chat-text` anchor in globals.css); the header, composer and sidebar stay put, so bigger text
 * buys reading area instead of eating it.
 *
 * Lives only in the md:hidden header: on a laptop the browser's own zoom is better and always
 * at hand. The scale itself is pinned back to 100% at md+ in CSS, so a desktop window narrowed
 * below the breakpoint can't strand a user with a size they have no control left to undo.
 */
export default function TextSizeControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const t = useT();
  // getChatScale snaps to the ladder, so this is only -1 if a caller passes something off-ladder;
  // treat that as "at default" rather than crashing the header.
  const i = Math.max(0, (CHAT_SCALE_STEPS as readonly number[]).indexOf(value));
  const percent = Math.round(CHAT_SCALE_STEPS[i] * 100);
  const atMin = i === 0;
  const atMax = i === CHAT_SCALE_STEPS.length - 1;

  // Clamped rather than gated by the `disabled` attribute: a natively disabled button drops out
  // of the tab order, so stepping to either end would dump keyboard focus onto <body> mid-tap.
  // aria-disabled keeps focus put and still tells assistive tech the button is inert.
  const step = (delta: number) => {
    const next = CHAT_SCALE_STEPS[i + delta];
    if (next === undefined) return;
    navigator.vibrate?.(10); // same nudge the message long-press uses (no-op on iOS)
    onChange(next);
  };

  return (
    <div role="group" aria-label={t.chat.textSize} className="ml-auto flex shrink-0 items-center gap-1">
      <button
        type="button"
        onClick={() => step(-1)}
        aria-disabled={atMin || undefined}
        title={t.chat.textSizeDecrease}
        aria-label={t.chat.textSizeDecrease}
        className={DISC}
      >
        {/* aria-hidden: the glyph is decoration — "A−" carries no meaning in zh/ko/ja, and some
            screen readers speak the sign aloud. The whole name comes from aria-label. */}
        <span aria-hidden="true" className="text-[11px] leading-none">
          A−
        </span>
      </button>

      <button
        type="button"
        onClick={() => onChange(DEFAULT_CHAT_SCALE)}
        // The accessible name contains the visible digits (WCAG 2.5.3 Label in Name) so a
        // speech-input user can say "tap 110 percent". Never disabled at 100% — a no-op tap is
        // harmless, and toggling the state on every step would be needless chatter.
        title={`${t.chat.textSizeValue(percent)} · ${t.chat.textSizeReset}`}
        aria-label={`${t.chat.textSizeValue(percent)}, ${t.chat.textSizeReset}`}
        className={`flex h-8 min-w-11 shrink-0 items-center justify-center rounded-lg px-2 text-xs font-medium tabular-nums transition ${
          // Flat readout at the default, tinted button once off it: the reset affordance appears
          // exactly when there is something to reset, and doubles as a "not at default" marker.
          percent === 100
            ? "text-black/50 hover:bg-black/5 dark:text-white/50 dark:hover:bg-white/10"
            : "bg-blue-600/10 text-blue-700 hover:bg-blue-600/15 dark:bg-blue-400/15 dark:text-blue-300 dark:hover:bg-blue-400/20"
        }`}
      >
        {percent}%
      </button>

      <button
        type="button"
        onClick={() => step(1)}
        aria-disabled={atMax || undefined}
        title={t.chat.textSizeIncrease}
        aria-label={t.chat.textSizeIncrease}
        className={DISC}
      >
        <span aria-hidden="true" className="text-[13px] leading-none">
          A+
        </span>
      </button>

      {/* Announces the new size after a tap. Separate from the pill so screen readers report the
          change without the pill's own label being re-read on every step. */}
      <span aria-live="polite" className="sr-only">
        {t.chat.textSizeValue(percent)}
      </span>
    </div>
  );
}

// 32px disc, matching the header hamburger's 34px hit box, on the app's usual subtle fill.
// touch-manipulation drops the 300ms double-tap-zoom delay so repeated taps step promptly.
const DISC =
  "flex h-8 w-8 shrink-0 touch-manipulation items-center justify-center rounded-full bg-black/5 font-semibold text-black/70 transition select-none hover:bg-black/10 aria-disabled:opacity-40 aria-disabled:hover:bg-black/5 dark:bg-white/10 dark:text-white/70 dark:hover:bg-white/15 dark:aria-disabled:hover:bg-white/10";
