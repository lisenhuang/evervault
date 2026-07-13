"use client";

import { useEffect, useRef } from "react";
import { Phone, PhoneOff } from "lucide-react";
import { useT } from "@/i18n/LanguageProvider";

/**
 * Shown after a live voice call auto-ends because the user went silent for the whole idle window
 * (see IDLE_TIMEOUT_MS in liveSession.ts). Explains that the hang-up was intentional — not a dropped
 * connection — and offers a one-tap Reconnect to resume the conversation. Matches ConfirmDialog's
 * centered-overlay pattern (no native dialogs — see web/CLAUDE.md): Escape and backdrop-click dismiss,
 * the Reconnect button takes focus on open, and both entrances reuse the app's shared motion tokens.
 */
export default function CallEndedModal({
  open,
  onReconnect,
  onClose,
}: {
  open: boolean;
  onReconnect: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const reconnectRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    reconnectRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.call.idleEndedTitle}
        onClick={(e) => e.stopPropagation()}
        className="animate-menu-in w-full max-w-sm rounded-2xl border border-black/10 bg-white p-6 text-center shadow-xl dark:border-white/10 dark:bg-neutral-900"
      >
        {/* Calm neutral badge — this was an intentional, money-saving hang-up, not an error. */}
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-black/[0.06] ring-1 ring-black/5 dark:bg-white/10 dark:ring-white/10">
          <PhoneOff className="h-6 w-6 text-black/70 dark:text-white/70" aria-hidden="true" />
        </div>

        <h2 className="mt-4 text-lg font-semibold">{t.call.idleEndedTitle}</h2>
        <p className="mt-2 text-sm text-black/60 dark:text-white/60">{t.call.idleEndedBody}</p>

        <div className="mt-6 flex flex-col gap-2">
          <button
            ref={reconnectRef}
            type="button"
            onClick={onReconnect}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-blue-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700"
          >
            <Phone size={16} aria-hidden="true" />
            {t.call.reconnect}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-4 py-2.5 text-sm font-medium text-black/60 transition hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
          >
            {t.call.dismiss}
          </button>
        </div>
      </div>
    </div>
  );
}
