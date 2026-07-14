"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { computeDropdownPlacement } from "./lib/dropdownPlacement";
import { GenderIcon, PREBUILT_VOICES, type Voice } from "./lib/voices";
import { useT } from "@/i18n/LanguageProvider";

const VOICES = [...PREBUILT_VOICES].sort((a, b) => a.name.localeCompare(b.name));

/**
 * Custom voice dropdown (a native <select> can't render an icon inside an
 * <option>). Shows a Venus/Mars glyph for the voice's gender instead of the
 * word "Male"/"Female", mirroring ModelSelect's portal + listbox pattern.
 */
export default function VoiceSelect({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [active, setActive] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  function genderLabel(gender: Voice["gender"]) {
    return gender === "Male" ? t.settings.voiceGenderMale : t.settings.voiceGenderFemale;
  }

  const selected = VOICES.find((v) => v.name === value);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
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
    setActive(Math.max(0, VOICES.findIndex((v) => v.name === value)));
    setOpen(true);
  }

  function pick(name: string) {
    onChange(name);
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
      setActive((i) => Math.min(VOICES.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(VOICES.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const v = VOICES[active];
      if (v) pick(v.name);
    }
  }

  const triggerCls =
    "mt-1 flex w-full items-center justify-between gap-2 rounded-lg border border-black/15 bg-transparent px-3 py-2 text-left text-sm outline-none transition focus:border-blue-500 dark:border-white/20 dark:bg-neutral-900";
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
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-opt-${active}` : undefined}
        className={triggerCls}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{selected ? `${selected.name} — ${selected.mood}` : value}</span>
          {selected && (
            <>
              <GenderIcon gender={selected.gender} size={14} />
              <span className="sr-only">{genderLabel(selected.gender)}</span>
            </>
          )}
        </span>
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
          // Portal to <body>: the drawer panel uses a CSS transform, which would
          // otherwise make this `position: fixed` popover resolve against the
          // drawer instead of the viewport (pushing it off-screen). Opens upward
          // instead of down when the trigger is near the bottom of the screen.
          <div
            ref={popRef}
            id={listId}
            role="listbox"
            aria-label={t.settings.voice}
            style={{
              position: "fixed",
              left: rect.left,
              width: rect.width,
              maxHeight: placement.maxHeight,
              ...(placement.openUp ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
            }}
            className="z-60 overflow-y-auto rounded-lg border border-black/10 bg-white py-1 shadow-xl dark:border-white/10 dark:bg-neutral-900"
          >
            {VOICES.map((v, i) => {
              const isSel = v.name === value;
              const isActive = i === active;
              return (
                <button
                  key={v.name}
                  id={`${listId}-opt-${i}`}
                  type="button"
                  role="option"
                  aria-selected={isSel}
                  title={genderLabel(v.gender)}
                  onClick={() => pick(v.name)}
                  onMouseEnter={() => setActive(i)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition ${
                    isActive ? "bg-black/5 dark:bg-white/10" : ""
                  } ${isSel ? "font-medium text-blue-600 dark:text-blue-400" : ""}`}
                >
                  <span className="truncate">
                    {v.name} — {v.mood}
                  </span>
                  <GenderIcon gender={v.gender} size={14} />
                  <span className="sr-only">{genderLabel(v.gender)}</span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
