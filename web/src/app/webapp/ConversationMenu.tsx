"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pencil, Pin, PinOff } from "lucide-react";
import { useT } from "@/i18n/LanguageProvider";

/**
 * Actions for one conversation in the history list, opened by right-click (desktop) or long-press
 * (touch). Rename and pin live here rather than as buttons on the row: two controls beside every
 * title left the title itself about half the sidebar's width, which is the one thing in the row
 * anyone actually reads.
 *
 * Portalled to document.body, and that is not optional. The mobile sidebar is a slide-in panel held
 * off-screen with `-translate-x-full`, and a transformed ancestor makes `position: fixed` resolve
 * against the panel instead of the viewport — so a menu rendered in place would sit relative to a
 * drawer that is itself mid-animation. Same trap the other popovers in /webapp document.
 */
export default function ConversationMenu({
  title,
  pinned,
  x,
  y,
  onRename,
  onTogglePin,
  onClose,
}: {
  /** The conversation's label, shown as the sheet's heading so a long-press is obviously scoped. */
  title: string;
  pinned: boolean;
  /** Pointer position (viewport coordinates) the menu anchors to on desktop. */
  x: number;
  y: number;
  onRename: () => void;
  onTogglePin: () => void;
  onClose: () => void;
}) {
  const t = useT();
  // The menu only ever mounts from a pointer interaction, so the device class is known at open time
  // and can't change while it's showing.
  const [sheet] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.("(hover: none) and (pointer: coarse)").matches,
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Anchored to fixed viewport coordinates — dismiss if the list scrolls underneath, so the menu
  // never floats detached from the row it belongs to.
  useEffect(() => {
    if (sheet) return;
    window.addEventListener("scroll", onClose, true);
    return () => window.removeEventListener("scroll", onClose, true);
  }, [sheet, onClose]);

  // Portals need a DOM to portal into. This menu only ever mounts from a pointer interaction, so it is
  // never server-rendered — the guard matches the other /webapp portals rather than tracking mount state.
  if (typeof document === "undefined") return null;

  const items = (
    <>
      <MenuItem
        icon={<Pencil size={sheet ? 18 : 15} aria-hidden="true" />}
        label={t.history.rename}
        sheet={sheet}
        onClick={onRename}
      />
      <MenuItem
        icon={
          pinned ? <PinOff size={sheet ? 18 : 15} aria-hidden="true" /> : <Pin size={sheet ? 18 : 15} aria-hidden="true" />
        }
        label={pinned ? t.history.unpin : t.history.pin}
        sheet={sheet}
        onClick={onTogglePin}
      />
    </>
  );

  const menu = sheet ? (
    <div
      className="fixed inset-0 z-50 animate-fade-in bg-black/40 backdrop-blur-[2px]"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="menu"
        aria-label={t.history.chatActions}
        onClick={(e) => e.stopPropagation()}
        className="absolute inset-x-0 bottom-0 animate-sheet-up rounded-t-2xl bg-white pb-[max(env(safe-area-inset-bottom),0.5rem)] shadow-2xl dark:bg-neutral-900"
      >
        <div className="mx-auto mt-2.5 h-1 w-9 rounded-full bg-black/15 dark:bg-white/20" aria-hidden="true" />
        <div className="border-b border-black/8 px-5 pt-3 pb-3.5 dark:border-white/10">
          <p className="truncate text-sm font-medium text-black/75 dark:text-white/75">{title}</p>
        </div>
        <div className="px-2 pt-1.5">{items}</div>
      </div>
    </div>
  ) : (
    <div
      className="fixed inset-0 z-50"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
      role="presentation"
    >
      <Popover x={x} y={y} label={t.history.chatActions}>
        {items}
      </Popover>
    </div>
  );

  return createPortal(menu, document.body);
}

/** Floating panel clamped to the viewport around the pointer position. */
function Popover({ x, y, label, children }: { x: number; y: number; label: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y]);
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      style={{ left: pos.left, top: pos.top }}
      onClick={(e) => e.stopPropagation()}
      className="fixed min-w-40 origin-top-left animate-menu-in overflow-hidden rounded-xl border border-black/10 bg-white/95 p-1 shadow-xl backdrop-blur dark:border-white/15 dark:bg-neutral-800/95"
    >
      {children}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  sheet,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  sheet: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center rounded-lg text-left transition hover:bg-black/5 dark:hover:bg-white/10 ${
        sheet ? "gap-3.5 px-3.5 py-3 text-[15px]" : "gap-2.5 px-2.5 py-1.5 text-sm"
      }`}
    >
      <span className="text-black/55 dark:text-white/55">{icon}</span>
      {label}
    </button>
  );
}
