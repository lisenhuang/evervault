"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Sparkles } from "lucide-react";
import { useT } from "@/i18n/LanguageProvider";

/**
 * Renaming a conversation on a touch screen, as a dialog rather than a box inside the row.
 *
 * The sidebar row is barely wider than a thumb, and a single-line input in it scrolls a long name out of
 * sight one character at a time. Here the name gets a wrapping field several lines tall, so the whole of
 * it is readable while it is being edited.
 *
 * A dialog also removes the thing that broke renaming on phones: an inline editor has to treat losing
 * focus as "finished", because dismissing the keyboard is how you finish — and that made tapping the
 * re-generate button close the editor before the name arrived. Nothing here closes except Save and
 * Cancel, so the keyboard can come and go freely.
 *
 * The field wraps for reading; the name itself stays one line. Newlines are folded back into spaces on
 * save, matching what the server stores.
 */
export default function RenameDialog({
  initialTitle,
  regenerating,
  onRegenerate,
  onSave,
  onClose,
}: {
  initialTitle: string;
  /** Whether a name is currently being generated, for the button's spinner. */
  regenerating: boolean;
  /** Ask for an AI-written name. Resolves to the name, or "" if it couldn't. */
  onRegenerate: () => Promise<string>;
  /** Save this name. Empty means "forget it" — the row goes back to its opening words. */
  onSave: (title: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(initialTitle);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Select what's there so replacing it outright is one keystroke, and refining it is still possible.
  // Deferred a frame: the dialog animates in, and focusing mid-animation is unreliable on iOS.
  useEffect(() => {
    const h = requestAnimationFrame(() => ref.current?.select());
    return () => cancelAnimationFrame(h);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  async function regenerate() {
    const title = await onRegenerate();
    // Straight into the box rather than saved: the dialog is still open and in front of the user, so
    // there is someone here to accept or edit it. Nothing is written until they say so.
    if (title) {
      setDraft(title);
      ref.current?.select();
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex animate-fade-in items-end justify-center bg-black/50 p-4 pb-[max(env(safe-area-inset-bottom),1rem)] backdrop-blur-[2px] sm:items-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t.history.rename}
        className="w-full max-w-md animate-menu-in rounded-2xl bg-white p-4 shadow-2xl dark:bg-neutral-900"
      >
        <h2 className="text-sm font-semibold">{t.history.rename}</h2>

        <textarea
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter saves rather than adding a line: this is a name, and the field is multi-line so the
            // whole of it can be read, not so it can hold paragraphs.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSave(draft);
            }
          }}
          rows={3}
          maxLength={200}
          aria-label={t.history.rename}
          className="mt-3 w-full resize-none rounded-xl border border-black/15 bg-transparent px-3 py-2.5 text-sm leading-relaxed outline-none focus:border-blue-500 dark:border-white/20"
        />

        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => void regenerate()}
            disabled={regenerating}
            className="flex items-center gap-1.5 rounded-lg border border-black/10 px-3 py-2 text-xs font-medium transition hover:bg-black/5 disabled:opacity-60 dark:border-white/15 dark:hover:bg-white/10"
          >
            {regenerating ? (
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles size={14} aria-hidden="true" />
            )}
            {t.history.regenerateTitle}
          </button>

          <div className="flex-1" />

          <button
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm font-medium transition hover:bg-black/5 dark:hover:bg-white/10"
          >
            {t.common.cancel}
          </button>
          <button
            onClick={() => onSave(draft)}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
          >
            {t.history.renameSave}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
