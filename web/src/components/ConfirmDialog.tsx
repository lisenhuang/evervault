"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

// A small reusable centered-modal confirmation dialog. We build our own (no native
// `confirm()` — see web/CLAUDE.md) so it stays styled and dark-mode aware. Button styles
// mirror the admin `Button` primitive (src/app/admin/ui.tsx) for a consistent look.

type Props = {
  open: boolean;
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: "primary" | "danger";
  busy?: boolean;
  /** When set, the user must type this exact word to enable the confirm button (destructive gate). */
  requireText?: string;
  inputPlaceholder?: string;
  onConfirm: () => void;
  onClose: () => void;
};

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmVariant = "primary",
  busy = false,
  requireText,
  inputPlaceholder,
  onConfirm,
  onClose,
}: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");

  // Reset the typed-confirmation field and focus (input if gated, else the confirm button)
  // whenever the dialog opens. Keyed on `open` only so the field isn't wiped mid-typing when
  // the parent re-renders and passes new handler identities.
  useEffect(() => {
    if (!open) return;
    setText("");
    (requireText != null ? inputRef.current : confirmRef.current)?.focus();
  }, [open, requireText]);

  // Escape closes, while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const gated = requireText != null && text.trim() !== requireText;
  const disabled = busy || gated;

  const confirmStyle =
    confirmVariant === "danger"
      ? "bg-red-600 text-white shadow-sm hover:bg-red-700"
      : "bg-blue-600 text-white shadow-sm hover:bg-blue-700";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-black/10 bg-white p-6 shadow-xl dark:border-white/10 dark:bg-neutral-900"
      >
        <h2 className="text-lg font-semibold">{title}</h2>
        {message && <p className="mt-2 text-sm text-black/60 dark:text-white/60">{message}</p>}
        {requireText != null && (
          <input
            ref={inputRef}
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !disabled) onConfirm();
            }}
            placeholder={inputPlaceholder}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="mt-4 w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none transition focus:border-black/30 dark:border-white/20 dark:focus:border-white/40"
          />
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-black/15 px-4 py-2 text-sm font-medium transition hover:bg-black/5 disabled:pointer-events-none disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={disabled}
            className={`rounded-md px-4 py-2 text-sm font-medium transition disabled:pointer-events-none disabled:opacity-50 ${confirmStyle}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
