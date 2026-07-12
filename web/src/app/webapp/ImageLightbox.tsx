"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useT } from "@/i18n/LanguageProvider";

export type LightboxImage = { src: string; alt: string };

/** A horizontal swipe must travel at least this far (px) to flip to the next/previous image. */
const SWIPE_THRESHOLD_PX = 50;

/**
 * Full-screen preview of one or more chat images. Opened by tapping an image bubble in the message
 * list. When a bubble holds several images the viewer becomes a gallery: previous/next arrows, a
 * "2 / 5" counter, arrow-key and swipe navigation, all wrapping around at the ends.
 *
 * Dismisses on the close button, a backdrop click, or Escape; the image and controls swallow clicks
 * so only the surrounding area closes. Rendered through a portal on `document.body` so it escapes
 * the chat's overflow/stacking context and truly covers the viewport, and locks background scroll
 * while open. Kept dependency-free (no third-party lightbox) to match the app's lightweight
 * components.
 */
export default function ImageLightbox({
  images,
  index,
  onClose,
}: {
  images: LightboxImage[];
  /** Which image to show first. */
  index: number;
  onClose: () => void;
}) {
  const t = useT();
  const [current, setCurrent] = useState(index);
  const touchStartX = useRef<number | null>(null);

  const many = images.length > 1;
  // Guard against an out-of-range initial index or an empty list.
  const safe = images.length ? ((current % images.length) + images.length) % images.length : 0;
  const img = images[safe];

  const go = useCallback(
    (delta: number) => {
      if (images.length < 2) return;
      setCurrent((c) => ((c + delta) % images.length + images.length) % images.length);
    },
    [images.length],
  );

  // Escape closes; arrow keys page through when there's more than one image.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, go]);

  // Freeze background scroll while the overlay is up, restoring whatever was there before.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  if (typeof document === "undefined" || !img) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex animate-fade-in select-none items-center justify-center bg-black/90 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
      onTouchStart={(e) => {
        touchStartX.current = e.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(e) => {
        const startX = touchStartX.current;
        touchStartX.current = null;
        if (startX == null) return;
        const dx = (e.changedTouches[0]?.clientX ?? startX) - startX;
        if (Math.abs(dx) > SWIPE_THRESHOLD_PX) go(dx < 0 ? 1 : -1);
      }}
      role="dialog"
      aria-modal="true"
      aria-label={img.alt}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label={t.message.closeImage}
        className="absolute top-[max(env(safe-area-inset-top),1rem)] right-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white shadow-lg backdrop-blur transition hover:bg-white/20 active:scale-95"
      >
        <X size={20} aria-hidden="true" />
      </button>

      {many && (
        <>
          <NavButton side="left" label={t.message.prevImage} onClick={() => go(-1)}>
            <ChevronLeft size={26} aria-hidden="true" />
          </NavButton>
          <NavButton side="right" label={t.message.nextImage} onClick={() => go(1)}>
            <ChevronRight size={26} aria-hidden="true" />
          </NavButton>
          <div
            className="absolute bottom-[max(env(safe-area-inset-bottom),1rem)] left-1/2 z-10 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-sm font-medium tabular-nums text-white shadow-lg backdrop-blur"
            aria-label={t.message.imageCounter(safe + 1, images.length)}
          >
            {safe + 1} / {images.length}
          </div>
        </>
      )}

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={safe}
        src={img.src}
        alt={img.alt}
        onClick={(e) => e.stopPropagation()}
        className="max-h-full max-w-full animate-menu-in cursor-default rounded-lg object-contain shadow-2xl"
      />
    </div>,
    document.body,
  );
}

/** An edge-anchored, vertically-centered navigation arrow. Clicks don't bubble to the backdrop. */
function NavButton({
  side,
  label,
  onClick,
  children,
}: {
  side: "left" | "right";
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`absolute top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white shadow-lg backdrop-blur transition hover:bg-white/20 active:scale-95 ${
        side === "left" ? "left-2 sm:left-4" : "right-2 sm:right-4"
      }`}
    >
      {children}
    </button>
  );
}
