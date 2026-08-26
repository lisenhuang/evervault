"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "@/i18n/LanguageProvider";
import {
  clampSidebarWidthToViewport,
  DEFAULT_SIDEBAR_WIDTH,
  maxSidebarWidth,
  SIDEBAR_MIN_WIDTH,
} from "./lib/store";

/** Arrow-key step, and the bigger stride Shift takes. Coarse enough to cross the range in a few
 *  presses, fine enough to land on a width you actually wanted. The bounds sit on this same grid
 *  (see the store), so every reachable width — the default included — is reachable by keyboard. */
const STEP = 16;
const BIG_STEP = 64;

/** How far past the floor you have to keep pulling before releasing closes the rail instead of
 *  clamping. Far enough that nobody hits it while merely making the rail narrow. */
const SNAP_SHUT_BELOW = SIDEBAR_MIN_WIDTH - 48;

/**
 * The drag handle on the right edge of the desktop rail.
 *
 * Three things make this more than an `onMouseMove`:
 *
 * 1. **It doesn't re-render React while you drag.** `Chat` is the root of the whole app (a very large
 *    tree, with neither the history list nor the transcript memoised), so putting the in-flight width
 *    in state would re-render everything at pointer rate — visible jank on a long conversation. Instead
 *    the drag writes the `--rail` custom property straight onto the rail element, which is the single
 *    thing the width is derived from, and only *commits* to React state — once — on release.
 * 2. **It is a real ARIA window splitter.** `role="separator"` with `aria-valuenow` is focusable and
 *    resizable from the keyboard (arrows, Shift+arrows, Home/End), and Enter collapses/restores, so
 *    the rail is adjustable without a pointer at all.
 * 3. **Dragging it shut hides the rail.** Pull past the floor and the rail dims to preview it, then
 *    closes on release. That is the affordance that makes hiding *discoverable*: a toggle button in a
 *    corner is easy to never notice, whereas everyone who resizes a panel eventually overshoots.
 *
 * Double-click puts the width back to the default, and Escape abandons a drag mid-gesture.
 */
export default function SidebarResizer({
  railRef,
  width,
  onCommit,
  onToggle,
}: {
  /** The rail element whose `--rail` property is the width. Written to directly during a drag. */
  railRef: React.RefObject<HTMLElement | null>;
  /** The committed width, in px — what React currently believes and what storage holds. */
  width: number;
  /** Called once per gesture with the final width. */
  onCommit: (px: number) => void;
  /** Hides the rail: Enter on the separator (the ARIA splitter's collapse affordance), and a drag
   *  pulled shut. */
  onToggle: () => void;
}) {
  const t = useT();
  const [dragging, setDragging] = useState(false);
  /** The width painted by the last pointermove — read on release, since it never went through state. */
  const liveRef = useRef(width);
  /** Tears down the drag in progress, if there is one. Held so unmount can call it. */
  const endDragRef = useRef<(() => void) | null>(null);

  // A drag still running when the rail unmounts (logout, say) would otherwise leave its window
  // listeners attached to a dead component and the document wearing a col-resize cursor for good.
  useEffect(() => () => endDragRef.current?.(), []);

  /** What the rail is ACTUALLY showing. Not the `width` prop: CSS caps the rail at half the window,
   *  so after a narrow the prop can exceed what is on screen — and a step from a width the user
   *  cannot see jumps. */
  const rendered = () => Math.round(railRef.current?.getBoundingClientRect().width ?? width);

  /** Paint a candidate width with no React involved. */
  const paint = (px: number) => {
    liveRef.current = px;
    railRef.current?.style.setProperty("--rail", `${px}px`);
  };

  /**
   * Hold off the rail's width transition, or hand it back.
   *
   * That transition exists for hide/show, where a 200ms slide is the point. On a *resize* it is a
   * bug: the rail eases towards each new width instead of landing on it, so it visibly trails the
   * cursor and every arrow-key press feels mushy. A resize should track the input exactly.
   */
  const freeze = (on: boolean) => {
    const rail = railRef.current;
    if (rail) rail.style.transitionProperty = on ? "none" : "";
  };

  /** Preview of "let go now and the rail closes". */
  const previewShut = (on: boolean) => {
    const rail = railRef.current;
    if (rail) rail.style.opacity = on ? "0.6" : "";
  };

  /** One discrete resize (a key press, a double-click). The width is flushed to layout while the
   *  transition is off, so it lands instantly — and the transition is back in place for the next
   *  hide/show, which still animates. */
  const commit = (px: number) => {
    freeze(true);
    paint(px);
    void railRef.current?.offsetWidth;
    freeze(false);
    onCommit(px);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Primary button only, and never a touch: at this breakpoint the rail is a desktop rail, and a
    // stray finger drag on a hybrid device should scroll the list, not resize the chrome.
    if (e.button !== 0 || e.pointerType === "touch") return;
    const rail = railRef.current;
    if (!rail) return;
    // Stops the browser starting a text selection or an image drag under the cursor.
    e.preventDefault();
    // The rail's own left edge, not the pointer offset: dragging then becomes "the rail ends where
    // the cursor is", which is what the cursor's position implies and survives the window scrolling.
    const left = rail.getBoundingClientRect().left;
    const startedAt = rendered();

    liveRef.current = startedAt;
    let willShut = false;
    setDragging(true);
    grabCursor();
    // Off for the whole gesture rather than per move: one write instead of one forced layout per
    // pointermove, and the rail sits exactly under the cursor the entire way.
    freeze(true);
    // Pointer capture keeps the gesture alive over iframes and outside the window; the listeners are
    // on `window` because captured events still bubble there, and pointerup can land anywhere.
    e.currentTarget.setPointerCapture?.(e.pointerId);

    const move = (ev: PointerEvent) => {
      const wanted = ev.clientX - left;
      // Past the snap threshold the rail stops narrowing and dims instead — the width is already at
      // its floor, so without the dimming there would be no feedback at all that pulling further
      // does something different.
      willShut = wanted < SNAP_SHUT_BELOW;
      previewShut(willShut);
      paint(clampSidebarWidthToViewport(wanted));
    };

    /** @param keep false to abandon the gesture and put the width back (Escape, or unmount). */
    const end = (keep: boolean) => {
      endDragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKey, true);
      releaseCursor();
      previewShut(false);
      if (!keep) {
        // Put the width back, and FLUSH it while the transition is still held off. Without the
        // flush this lands in the same style recalculation as `freeze(false)` below, and the rail
        // eases back over 200ms — which reads as the drag still settling rather than as a cancel.
        paint(startedAt);
        void rail.offsetWidth;
      }
      // Handed back BEFORE the commit: React then writes the width it already has, which is a no-op,
      // so nothing animates now and the next hide/show still does.
      freeze(false);
      setDragging(false);
      if (!keep) return;
      // Pulled shut: hide the rail and leave the STORED width alone, so showing it again brings back
      // the rail the user last chose rather than the sliver they dragged through on the way out.
      if (willShut) {
        paint(startedAt);
        onToggle();
      } else {
        onCommit(liveRef.current);
      }
    };

    const onUp = () => end(true);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      // Captured and stopped: Escape during a drag means "undo this drag", never "close the dialog
      // behind it" — and something is always listening for Escape in this app.
      ev.preventDefault();
      ev.stopPropagation();
      end(false);
    };

    endDragRef.current = () => end(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKey, true);
  };

  /**
   * Land a keyboard step on the 16px grid anchored at the DEFAULT.
   *
   * Without this the arrows just add 16 to wherever a freehand drag happened to stop, so a rail
   * dragged to 337px steps 353, 369, … and never once lands on 240 — the width it shipped with, and
   * the one people most want back. Snapping means the arrows can always walk home.
   */
  const snap = (px: number) =>
    clampSidebarWidthToViewport(
      DEFAULT_SIDEBAR_WIDTH + Math.round((px - DEFAULT_SIDEBAR_WIDTH) / STEP) * STEP,
    );

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Note the direction: the handle is on the RIGHT edge, so ArrowRight widens. Mirrored under RTL
    // would need the reverse, but the app has no RTL locale.
    const from = rendered();
    const stride = e.shiftKey ? BIG_STEP : STEP;
    if (e.key === "ArrowLeft") commit(snap(from - stride));
    else if (e.key === "ArrowRight") commit(snap(from + stride));
    else if (e.key === "Home") commit(SIDEBAR_MIN_WIDTH);
    else if (e.key === "End") commit(maxSidebarWidth());
    else if (e.key === "Enter") onToggle();
    else return;
    e.preventDefault();
  };

  // What is on screen, which is what the splitter must report — `width` alone would announce a
  // number the rail is wider than in a window too narrow to honour it.
  const shown = clampSidebarWidthToViewport(width);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t.sidebar.resize}
      aria-controls="ev-sidebar"
      aria-valuenow={shown}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={maxSidebarWidth()}
      aria-valuetext={t.sidebar.widthValue(shown)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => commit(DEFAULT_SIDEBAR_WIDTH)}
      title={`${t.sidebar.resize} · ${t.sidebar.resetWidth}`}
      // 12px of grab area straddling the rail's own 12px padding, so the target is comfortable
      // without ever sitting over a conversation title. `group` drives the hairline below.
      // The default focus ring is dropped for a reason, not for looks: on a 12px × full-height strip
      // it draws a black rectangle down the whole window. The hairline below replaces it — thicker
      // and solid blue when focused, which is the same indicator the drag itself uses.
      className="group absolute inset-y-0 right-0 z-20 hidden w-3 cursor-col-resize touch-none outline-none md:block"
    >
      {/* The affordance itself: a hairline that lights up on hover, focus and during the drag. It is
          the only moving part, so a resize never repaints the rail's contents. */}
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 right-0 transition-[background-color,width] group-hover:bg-blue-500/60 group-focus-visible:w-[3px] group-focus-visible:bg-blue-500 motion-reduce:transition-none ${
          dragging ? "w-[3px] bg-blue-500" : "w-0.5 bg-transparent"
        }`}
      />
    </div>
  );
}

/**
 * Hold the resize cursor and suppress selection for the whole document while a drag is running.
 *
 * Both are on `<body>` rather than the handle: once the pointer leaves the 12px strip — which it does
 * immediately — a cursor set on the handle stops applying, and any text the pointer sweeps across
 * would highlight behind the drag.
 */
function grabCursor() {
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
}

function releaseCursor() {
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}
