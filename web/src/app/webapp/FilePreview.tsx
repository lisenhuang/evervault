"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, FileAudio, FileText, Image as ImageIcon, X } from "lucide-react";
import { fileObjectUrl, formatSize, HandoffRevokeMs, type PreparedFile } from "./lib/files";
import { useT } from "@/i18n/LanguageProvider";

/** The icon standing in for the file in the header, by what kind of file it is. Mirrors the chips. */
const KIND_ICONS = {
  image: ImageIcon,
  audio: FileAudio,
  pdf: FileText,
  text: FileText,
} as const;

/**
 * Full-screen preview of one non-image chat attachment, opened by tapping its chip in the message
 * list — a PDF renders in an iframe, an extracted document shows its text, an audio clip gets a
 * player. Images don't come here; they have their own gallery in ImageLightbox.
 *
 * Structurally a sibling of that lightbox: rendered through a portal on `document.body` so it escapes
 * the chat's overflow/stacking context and truly covers the viewport, dismissed by the close button,
 * a backdrop click, or Escape, and it locks background scroll while open. Dependency-free (no
 * third-party viewer) to match the app's lightweight components.
 */
export default function FilePreview({ file, onClose }: { file: PreparedFile; onClose: () => void }) {
  const t = useT();
  // The blob URL, minted in a lazy initializer so the very first paint already has it — an iframe
  // pointed at nothing flashes a browser error page. `null` for kind "text", which needs no blob.
  // The call site keys this component on the file id, so a different attachment remounts and mints
  // its own URL.
  const [url] = useState<string | null>(() => fileObjectUrl(file));

  // Revoking matters — leaking a 10MB PDF per open piles up over a long session with nothing to
  // release it — but revoking the instant the modal closes is wrong twice over:
  //   1. the header's "Open" link may have just handed this exact URL to a new tab, which would go
  //      blank the moment the user dismisses the modal behind it;
  //   2. StrictMode simulates unmount→remount in dev, and a synchronous revoke there would kill the
  //      URL the remounted component is still holding, blanking the panel with no way to re-mint it.
  // So the cleanup only *schedules* the revoke, and a re-running effect cancels a pending one — which
  // is exactly what makes the StrictMode round-trip harmless. Same deferral (and constant) as the
  // new-tab handoff in openFileInNewTab.
  const revokeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!url) return;
    if (revokeTimer.current) {
      clearTimeout(revokeTimer.current);
      revokeTimer.current = null;
    }
    return () => {
      revokeTimer.current = setTimeout(() => URL.revokeObjectURL(url), HandoffRevokeMs);
    };
  }, [url]);

  // Escape closes, matching the lightbox.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Freeze background scroll while the overlay is up, restoring whatever was there before.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  if (typeof document === "undefined") return null;

  const Icon = KIND_ICONS[file.kind];
  // Audio needs a strip, not a page — only the document kinds claim the full height.
  const tall = file.kind === "pdf" || file.kind === "text";

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex animate-fade-in items-center justify-center bg-black/90 p-4 pt-[max(env(safe-area-inset-top),1rem)] pb-[max(env(safe-area-inset-bottom),1rem)] backdrop-blur-sm sm:p-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={file.name}
    >
      <div
        // Clicks inside the panel must not reach the backdrop, or scrolling a PDF would close it.
        onClick={(e) => e.stopPropagation()}
        className={`flex w-full max-w-3xl animate-menu-in flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-neutral-900 ${
          tall ? "h-full" : "max-h-full"
        }`}
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b border-black/10 px-3 py-2.5 dark:border-white/10">
          <Icon size={18} className="shrink-0 opacity-55" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium" title={file.name}>
              {file.name}
            </span>
            <span className="block text-xs text-black/45 dark:text-white/45">{formatSize(file.size)}</span>
          </span>

          {/* A real anchor, not window.open: an anchor carries the user's tap as its activation and
              isn't treated as a popup, which iOS Safari blocks far more readily. Absent for text,
              which has no blob to open — its content is already fully shown below. */}
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="flex shrink-0 items-center gap-1.5 rounded-full bg-black/5 px-3 py-1.5 text-xs font-medium transition hover:bg-black/10 active:scale-95 dark:bg-white/10 dark:hover:bg-white/20"
            >
              <ExternalLink size={14} aria-hidden="true" />
              {t.message.openFile}
            </a>
          )}

          <button
            type="button"
            onClick={onClose}
            aria-label={t.message.closeFile}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition hover:bg-black/5 active:scale-95 dark:hover:bg-white/10"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {file.kind === "pdf" ? (
          // A PDF should always have inline bytes; if one somehow doesn't, show a neutral panel
          // rather than an iframe pointed at nothing, which flashes a browser error page.
          url ? (
            <iframe src={url} title={file.name} className="min-h-0 w-full flex-1 border-0 bg-neutral-100 dark:bg-neutral-950" />
          ) : (
            <div className="min-h-0 flex-1 bg-neutral-100 dark:bg-neutral-950" />
          )
        ) : file.kind === "text" ? (
          <pre className="min-h-0 flex-1 overflow-auto px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap break-words">
            {file.text}
          </pre>
        ) : file.kind === "audio" ? (
          <div className="flex items-center justify-center px-4 py-5">
            {url && <audio controls src={url} className="w-full max-w-md" />}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
