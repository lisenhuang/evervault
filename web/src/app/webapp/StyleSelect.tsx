"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { computeDropdownPlacement } from "./lib/dropdownPlacement";
import { RESPONSE_STYLES, type ResponseStyle } from "./lib/responseStyle";
import { useT } from "@/i18n/LanguageProvider";

/**
 * Dropdown picker for a response-style preset. Used three times in the settings drawer
 * (text / voice / live) — a wrap of pills for each surface added up to too many buttons, so
 * each surface now gets a compact <select>-style dropdown instead. Mirrors VoiceSelect's
 * portal + listbox pattern so it stays fully keyboard/tap accessible and escapes the drawer's
 * CSS transform. "default" is always offered first as the leave-it-alone choice.
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

  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [active, setActive] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (popRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, listId]);

  function openList() {
    if (btnRef.current) setRect(btnRef.current.getBoundingClientRect());
    setActive(Math.max(0, RESPONSE_STYLES.indexOf(value)));
    setOpen(true);
  }

  function pick(s: ResponseStyle) {
    onChange(s);
    setOpen(false);
    btnRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openList();
      }
      return;
    }
    if (e.key === "Escape" || e.key === "Tab") {
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(RESPONSE_STYLES.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(RESPONSE_STYLES.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const s = RESPONSE_STYLES[active];
      if (s) pick(s);
    }
  }

  const triggerCls =
    "mt-2 flex w-full items-center justify-between gap-2 rounded-lg border border-black/15 bg-transparent px-3 py-2 text-left text-sm outline-none transition focus:border-blue-500 dark:border-white/20 dark:bg-neutral-900";
  const placement = open && rect ? computeDropdownPlacement(rect) : null;

  return (
    <div className="block">
      <button
        ref={btnRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-opt-${active}` : undefined}
        className={triggerCls}
      >
        <span className="truncate">{label(value)}</span>
        <ChevronDown
          size={16}
          className={`shrink-0 text-black/40 transition dark:text-white/40 ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {open &&
        rect &&
        placement &&
        typeof document !== "undefined" &&
        createPortal(
          // Portal to <body>: the drawer panel uses a CSS transform, which would otherwise make
          // this `position: fixed` popover resolve against the drawer instead of the viewport.
          // Opens upward instead of down when the trigger is near the bottom of the screen.
          <div
            ref={popRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            style={{
              position: "fixed",
              left: rect.left,
              width: rect.width,
              maxHeight: placement.maxHeight,
              ...(placement.openUp ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
            }}
            className="z-60 overflow-y-auto rounded-lg border border-black/10 bg-white py-1 shadow-xl dark:border-white/10 dark:bg-neutral-900"
          >
            {RESPONSE_STYLES.map((s, i) => {
              const isSel = s === value;
              const isActive = i === active;
              return (
                <button
                  key={s}
                  id={`${listId}-opt-${i}`}
                  type="button"
                  role="option"
                  aria-selected={isSel}
                  onClick={() => pick(s)}
                  onMouseEnter={() => setActive(i)}
                  className={`flex w-full items-center px-3 py-2 text-left text-sm transition ${
                    isActive ? "bg-black/5 dark:bg-white/10" : ""
                  } ${isSel ? "font-medium text-blue-600 dark:text-blue-400" : ""}`}
                >
                  <span className="truncate">{label(s)}</span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
