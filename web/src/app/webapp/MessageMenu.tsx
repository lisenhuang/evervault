"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Copy, Reply } from "lucide-react";
import type { ChatMessage } from "./types";
import { useT } from "@/i18n/LanguageProvider";

const COPIED_CLOSE_MS = 600;

/**
 * Actions for one chat message, opened by right-click (desktop) or long-press (touch).
 * Renders as a floating popover anchored at the pointer on hover-capable devices, and as a
 * bottom action sheet (with a preview of the pressed message) on touch devices.
 */
export default function MessageMenu({
  message,
  x,
  y,
  onReply,
  onClose,
}: {
  message: ChatMessage;
  /** Pointer position (viewport coordinates) the menu anchors to on desktop. */
  x: number;
  y: number;
  onReply: () => void;
  onClose: () => void;
}) {
  const t = useT();
  // The menu only ever mounts from a pointer interaction, so the device class is known at open
  // time and can't change while it's showing.
  const [sheet] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.("(hover: none) and (pointer: coarse)").matches,
  );
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The popover is anchored to fixed viewport coordinates — dismiss it if the chat scrolls
  // underneath, so it never floats detached from its message.
  useEffect(() => {
    if (sheet) return;
    window.addEventListener("scroll", onClose, true);
    return () => window.removeEventListener("scroll", onClose, true);
  }, [sheet, onClose]);

  function copyText() {
    void navigator.clipboard?.writeText(message.text).catch(() => {});
    setCopied(true);
    setTimeout(onClose, COPIED_CLOSE_MS);
  }

  const senderName = message.role === "user" ? t.message.you : t.message.assistantName;
  const preview = message.text || t.message.voiceMessage;

  const items = (
    <>
      <MenuItem
        icon={<Reply size={sheet ? 18 : 15} aria-hidden="true" />}
        label={t.message.reply}
        sheet={sheet}
        onClick={onReply}
      />
      {!!message.text && (
        <MenuItem
          icon={
            copied ? (
              <Check size={sheet ? 18 : 15} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            ) : (
              <Copy size={sheet ? 18 : 15} aria-hidden="true" />
            )
          }
          label={copied ? t.message.copied : t.message.copy}
          sheet={sheet}
          onClick={copied ? undefined : copyText}
        />
      )}
    </>
  );

  if (sheet) {
    return (
      <div
        className="fixed inset-0 z-50 animate-fade-in bg-black/40 backdrop-blur-[2px]"
        onClick={onClose}
        role="presentation"
      >
        <div
          role="menu"
          aria-label={t.message.messageActions}
          onClick={(e) => e.stopPropagation()}
          className="absolute inset-x-0 bottom-0 animate-sheet-up rounded-t-2xl bg-white pb-[max(env(safe-area-inset-bottom),0.5rem)] shadow-2xl dark:bg-neutral-900"
        >
          <div className="mx-auto mt-2.5 h-1 w-9 rounded-full bg-black/15 dark:bg-white/20" aria-hidden="true" />
          <div className="border-b border-black/8 px-5 pt-3 pb-3.5 dark:border-white/10">
            <div className="text-xs font-semibold text-black/50 dark:text-white/50">{senderName}</div>
            <p className="mt-0.5 line-clamp-2 text-sm text-black/75 dark:text-white/75">{preview}</p>
          </div>
          <div className="px-2 pt-1.5">{items}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} role="presentation">
      <Popover x={x} y={y} label={t.message.messageActions}>
        {items}
      </Popover>
    </div>
  );
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
  onClick?: () => void;
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
