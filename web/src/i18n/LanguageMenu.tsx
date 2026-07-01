"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Languages } from "lucide-react";
import { useLang } from "./LanguageProvider";
import { LANGS, LANG_LABELS, LANG_SHORT, type Lang } from "./config";

/**
 * Language selector rendered as a dropdown MENU (not a two-way toggle) so it scales past two
 * languages — add an entry to `LANGS` + `LANG_LABELS` + `LANG_SHORT` and its dictionary, and it
 * shows up here automatically. Two trigger shapes:
 * - `variant="button"` — compact icon trigger for the landing header.
 * - `variant="row"` — a wider trigger for the Sidebar settings row.
 * The active language is known on the server (cookie / Accept-Language), so SSR and the first client
 * render already agree — no `mounted` gate needed (unlike the theme toggle).
 *
 * The open list is portalled to <body> and keyboard-navigable, mirroring ModelSelect: the drawer
 * uses a CSS transform, which would otherwise make a `position: fixed` popover resolve against the
 * drawer instead of the viewport.
 */
export default function LanguageMenu({ variant = "button" }: { variant?: "button" | "row" }) {
  const { lang, setLang, t } = useLang();
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [active, setActive] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  // Outside-click / scroll / resize close while open (focus stays on the trigger, so navigation
  // keys are handled by the button's onKeyDown below).
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

  // Keep the active option scrolled into view.
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, listId]);

  function openList() {
    if (btnRef.current) setRect(btnRef.current.getBoundingClientRect());
    setActive(Math.max(0, LANGS.indexOf(lang)));
    setOpen(true);
  }

  function pick(next: Lang) {
    setLang(next);
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
      setActive((i) => Math.min(LANGS.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(LANGS.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const l = LANGS[active];
      if (l) pick(l);
    }
  }

  const triggerCls =
    variant === "row"
      ? "inline-flex items-center gap-1.5 rounded-lg bg-black/5 px-2.5 py-1 text-xs font-medium text-black/70 transition hover:bg-black/10 dark:bg-white/10 dark:text-white/70 dark:hover:bg-white/15"
      : "inline-flex items-center gap-1.5 rounded-md p-2 text-black/60 transition hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10";

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={t.language.label}
        title={t.language.label}
        className={triggerCls}
      >
        {variant === "row" ? (
          <span>{LANG_LABELS[lang]}</span>
        ) : (
          <>
            <Languages size={18} aria-hidden="true" />
            <span className="text-xs font-medium">{LANG_SHORT[lang]}</span>
          </>
        )}
        <ChevronDown
          size={14}
          className={`shrink-0 text-black/40 transition dark:text-white/40 ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {open &&
        rect &&
        typeof document !== "undefined" &&
        createPortal(
          // Portal to <body>: see the component doc-comment. Right-aligned to the trigger so the menu
          // never overflows the viewport edge for the top-right header / right-of-row triggers.
          <div
            ref={popRef}
            id={listId}
            role="listbox"
            aria-label={t.language.label}
            style={{
              position: "fixed",
              top: rect.bottom + 4,
              right: window.innerWidth - rect.right,
              minWidth: Math.max(rect.width, 140),
            }}
            className="z-60 max-h-64 overflow-y-auto rounded-lg border border-black/10 bg-white py-1 shadow-xl dark:border-white/10 dark:bg-neutral-900"
          >
            {LANGS.map((l, i) => {
              const isSel = l === lang;
              const isActive = i === active;
              return (
                <button
                  key={l}
                  id={`${listId}-opt-${i}`}
                  type="button"
                  role="option"
                  aria-selected={isSel}
                  onClick={() => pick(l)}
                  onMouseEnter={() => setActive(i)}
                  className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition ${
                    isActive ? "bg-black/5 dark:bg-white/10" : ""
                  } ${isSel ? "font-medium text-blue-600 dark:text-blue-400" : ""}`}
                >
                  <span className="truncate">{LANG_LABELS[l]}</span>
                  {isSel && <Check size={14} className="shrink-0" aria-hidden="true" />}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
