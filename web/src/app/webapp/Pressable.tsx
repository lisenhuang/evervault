"use client";

import { type ReactNode, useCallback, useEffect, useRef } from "react";

// Long-press timing for the touch path (iOS never fires `contextmenu`; Android does, but the two
// paths converge on the same open call). Small drags within the tolerance still count as a press.
const LONG_PRESS_MS = 450;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

/**
 * Makes its children open a context menu: right-click / two-finger-tap via `contextmenu` (default
 * menu suppressed), and long-press via a touch timer for browsers that don't map long-press to
 * `contextmenu` (iOS Safari). Callers should pair this with `[@media(hover:none)]:select-none` so
 * long-press doesn't fight text selection on touch.
 *
 * Shared by the message bubbles and the history rows — the same gesture opens both, and a second
 * copy of this timing would be two behaviours that drift.
 */
export default function Pressable({
  onOpen,
  disabled,
  className,
  children,
}: {
  onOpen: (x: number, y: number) => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef({ x: 0, y: 0 });
  // Set when a long press opened the menu, so the click some browsers still fire on release doesn't
  // also follow a link the finger happened to be resting on. Cleared by the next touch, so a plain
  // tap right after is never swallowed.
  const openedByPress = useRef(false);
  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  useEffect(() => clear, [clear]);

  return (
    <div
      ref={host}
      className={className}
      onClickCapture={(e) => {
        if (!openedByPress.current) return;
        openedByPress.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
      onContextMenu={(e) => {
        if (disabled) return;
        e.preventDefault();
        // The keyboard raises `contextmenu` too (the Menu key, Shift+F10) and reports no pointer to
        // anchor to. Falling back to the element itself is what keeps the menu reachable without a
        // mouse — anchoring at 0,0 would pin it to the corner of the screen instead.
        if (e.clientX === 0 && e.clientY === 0) {
          const r = host.current?.getBoundingClientRect();
          onOpen(r ? r.left + 8 : 0, r ? r.bottom : 0);
          return;
        }
        onOpen(e.clientX, e.clientY);
      }}
      onTouchStart={(e) => {
        if (disabled || e.touches.length !== 1) {
          clear();
          return;
        }
        const touch = e.touches[0];
        start.current = { x: touch.clientX, y: touch.clientY };
        openedByPress.current = false;
        clear();
        timer.current = setTimeout(() => {
          timer.current = null;
          openedByPress.current = true;
          navigator.vibrate?.(10);
          onOpen(start.current.x, start.current.y);
        }, LONG_PRESS_MS);
      }}
      onTouchMove={(e) => {
        const touch = e.touches[0];
        if (
          touch &&
          Math.hypot(touch.clientX - start.current.x, touch.clientY - start.current.y) >
            LONG_PRESS_MOVE_TOLERANCE_PX
        ) {
          clear();
        }
      }}
      onTouchEnd={clear}
      onTouchCancel={clear}
    >
      {children}
    </div>
  );
}
