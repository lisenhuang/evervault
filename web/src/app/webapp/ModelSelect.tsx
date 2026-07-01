"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BadgeCheck, ChevronDown } from "lucide-react";
import { computeDropdownPlacement } from "./lib/dropdownPlacement";
import type { ModelInfo } from "./lib/gemini";

/**
 * Custom model dropdown (a native <select> can't render an icon inside an
 * <option>). Shows the lucide BadgeCheck after the recommended model's name,
 * in the open list and on the closed trigger when the recommended one is
 * selected. Keeps the currently-selected model visible even if it isn't in the
 * fetched list yet (e.g. a preview id).
 */
export default function ModelSelect({
  label,
  value,
  options,
  recommendedId,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  options: ModelInfo[];
  recommendedId: string;
  onChange: (id: string) => void;
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [active, setActive] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  // Ensure the selected value always renders, even if it's not in the list yet.
  const items: ModelInfo[] = options.some((m) => m.id === value)
    ? options
    : [{ id: value, displayName: value, methods: [] }, ...options];
  const selected = items.find((m) => m.id === value);

  // Outside-click / scroll / resize close while open (focus stays on the trigger,
  // so navigation keys are handled by the button's onKeyDown below).
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    // Close when the page/drawer scrolls (the fixed popover would otherwise
    // detach from the trigger) — but ignore the popover's OWN internal scroll,
    // which fires when we scroll the active option into view on open.
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
    setActive(Math.max(0, items.findIndex((m) => m.id === value)));
    setOpen(true);
  }

  function pick(id: string) {
    onChange(id);
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
      setActive((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(items.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const m = items[active];
      if (m) pick(m.id);
    }
  }

  const triggerCls =
    "mt-1 flex w-full items-center justify-between gap-2 rounded-lg border border-black/15 bg-transparent px-3 py-2 text-left text-sm outline-none transition focus:border-blue-500 dark:border-white/20 dark:bg-neutral-900";
  const placement = open && rect ? computeDropdownPlacement(rect) : null;

  return (
    <div className="block">
      <span className="text-xs font-medium text-black/70 dark:text-white/70">{label}</span>
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
          <span className="truncate">{selected?.displayName ?? value}</span>
          {value === recommendedId && (
            <BadgeCheck size={14} className="shrink-0 text-blue-600 dark:text-blue-400" aria-hidden="true" />
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
            aria-label={label}
            style={{
              position: "fixed",
              left: rect.left,
              width: rect.width,
              maxHeight: placement.maxHeight,
              ...(placement.openUp ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
            }}
            className="z-60 overflow-y-auto rounded-lg border border-black/10 bg-white py-1 shadow-xl dark:border-white/10 dark:bg-neutral-900"
          >
            {items.map((m, i) => {
              const isSel = m.id === value;
              const isActive = i === active;
              return (
                <button
                  key={m.id}
                  id={`${listId}-opt-${i}`}
                  type="button"
                  role="option"
                  aria-selected={isSel}
                  onClick={() => pick(m.id)}
                  onMouseEnter={() => setActive(i)}
                  className={`flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm transition ${
                    isActive ? "bg-black/5 dark:bg-white/10" : ""
                  } ${isSel ? "font-medium text-blue-600 dark:text-blue-400" : ""}`}
                >
                  <span className="truncate">{m.displayName}</span>
                  {m.id === recommendedId && (
                    <BadgeCheck size={14} className="shrink-0 text-blue-600 dark:text-blue-400" aria-hidden="true" />
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )}

      {hint && <span className="mt-1 block text-xs text-black/45 dark:text-white/45">{hint}</span>}
    </div>
  );
}
