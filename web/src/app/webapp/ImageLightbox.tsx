"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useT } from "@/i18n/LanguageProvider";

/**
 * Full-screen preview of a chat image. Opened by tapping an image bubble in the message list.
 * Dismisses on the close button, a backdrop click, or Escape; the image itself swallows clicks so
 * only the surrounding area closes. Rendered through a portal on `document.body` so it escapes the
 * chat's overflow/stacking context and truly covers the viewport, and locks background scroll while
 * open. Kept dependency-free (no third-party lightbox) to match the app's lightweight components.
 */
export default function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const t = useT();

  // Escape closes.
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

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex animate-fade-in items-center justify-center bg-black/90 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label={t.message.closeImage}
        className="absolute top-[max(env(safe-area-inset-top),1rem)] right-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white shadow-lg backdrop-blur transition hover:bg-white/20 active:scale-95"
      >
        <X size={20} aria-hidden="true" />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        className="max-h-full max-w-full animate-menu-in cursor-default rounded-lg object-contain shadow-2xl"
      />
    </div>,
    document.body,
  );
}
