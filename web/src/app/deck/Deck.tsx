"use client";

// The deck runtime: navigation, layout, the overview grid and the print sheet. All the words live
// in slides.tsx; this file only decides which slide is showing and what shape it takes.
//
// TWO LAYOUTS, AND TWO LANGUAGES OVER THE SAME STRUCTURE.
//
// * canvas — the slide is laid out against a constant 1280x720 box and the whole box is scaled with
//   a CSS transform to fit the viewport. Because the fit is min(w, h), any landscape ratio works and
//   simply letterboxes: 16:9 fills exactly, 16:10 and 4:3 gain side bars, 21:9 gains top and bottom
//   ones. Nothing reflows, so what you rehearsed on the laptop is what the projector shows.
//
// * flow — below the size where that scaling would shrink body copy past reading, the same slides
//   reflow: grids collapse to one column, the type scale drops to its phone values, diagrams keep a
//   floor width and scroll sideways, and each slide becomes a scrollable page you swipe between. A
//   phone held upright gets a readable document rather than a postage-stamp slide.
//
// The threshold is deliberately expressed in terms of the resulting text size rather than a device
// guess, so an odd viewport (a narrow desktop window, a split-screen tablet) is judged on whether
// the canvas would still be legible in it.
//
// Language is a third axis over both layouts, and unlike theme it is deliberately NOT remembered:
// see the `lang` state below for why.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  Grid2x2,
  Maximize,
  Minimize,
  Moon,
  Sparkles,
  Sun,
  SunMoon,
  X,
} from "lucide-react";
import { useTheme, type ThemePreference } from "@/components/theme/ThemeProvider";
import { SLIDES, type SlideDef } from "./slides";
import { SLIDES_ZH } from "./slidesZh";
import { DeckLangContext, type DeckLang } from "./lang";
import { Kbd } from "./ui";

/** The canvas every slide is laid out against. 16:9. */
const W = 1280;
const H = 720;

/** Below this canvas scale the 19px body copy would render under ~11px. Reflow instead. */
const MIN_CANVAS_SCALE = 0.58;
/** …and below this width there is no room for two columns whatever the scale says. */
const MIN_CANVAS_WIDTH = 700;

/** Chrome and the mouse pointer fade after this long without input, so a paused slide is clean. */
const IDLE_MS = 2600;

type Layout = { mode: "canvas" | "flow"; scale: number; thumb: number };

function measure(): Layout {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const scale = Math.min(vw / W, vh / H);
  const flow = vw < MIN_CANVAS_WIDTH || scale < MIN_CANVAS_SCALE;
  // Overview thumbnails: match the grid's own column count so the cells never overflow the page.
  const cols = vw >= 1024 ? 4 : vw >= 640 ? 3 : 2;
  const available = Math.min(vw, 1152) - 48 - (cols - 1) * 20;
  const thumb = Math.max(120, Math.min(252, Math.floor(available / cols)));
  return { mode: flow ? "flow" : "canvas", scale: flow ? 1 : scale, thumb };
}

export default function Deck() {
  const [index, setIndex] = useState(0);
  // Reading language. Held in state only: never a cookie, never localStorage, never the URL. The
  // deck must open in English every single time, including after a refresh mid-rehearsal, because
  // the English deck is the one the audience sees. Chinese is a comprehension aid you step into on
  // purpose and lose the moment the page reloads — which is the desired behaviour, not a gap.
  const [lang, setLang] = useState<DeckLang>("en");
  // Server render and first client render must agree, so start at the canvas default and measure
  // in an effect. The slide is invisible for one frame either way.
  const [layout, setLayout] = useState<Layout>({ mode: "canvas", scale: 1, thumb: 252 });
  const [overview, setOverview] = useState(false);
  const [help, setHelp] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Both decks carry the same ids in the same order (slidesZh.tsx asserts it in development), so
  // switching language keeps you on the slide you were reading.
  const slides: SlideDef[] = lang === "zh" ? SLIDES_ZH : SLIDES;
  const count = slides.length;
  const last = count - 1;
  const flow = layout.mode === "flow";
  const clamp = useCallback((n: number) => Math.max(0, Math.min(last, n)), [last]);

  const go = useCallback(
    (n: number) => {
      setIndex((current) => {
        const next = Math.max(0, Math.min(count - 1, n));
        // replaceState, not push: a talk should not leave 25 entries in the back button.
        if (next !== current) window.history.replaceState(null, "", `#${next + 1}`);
        return next;
      });
    },
    [count],
  );

  /* --------------------------------------------------- measure the viewport */

  useEffect(() => {
    const fit = () => setLayout(measure());
    fit();
    window.addEventListener("resize", fit);
    window.addEventListener("orientationchange", fit);
    return () => {
      window.removeEventListener("resize", fit);
      window.removeEventListener("orientationchange", fit);
    };
  }, []);

  /* -------------------------------------------- deep link: /deck#7 opens slide 7 */

  useEffect(() => {
    const fromHash = () => {
      const n = Number.parseInt(window.location.hash.slice(1), 10);
      if (Number.isFinite(n)) setIndex(clamp(n - 1));
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [clamp]);

  /** A reflowed slide scrolls, so a new one has to start at its top rather than wherever the last
   *  one was left. */
  useEffect(() => {
    if (flow) rootRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [index, flow]);

  /* ----------------------------------------------------------------- keyboard */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;

      if (k === "Escape") {
        if (overview) setOverview(false);
        else if (help) setHelp(false);
        return;
      }
      if (k === "?" || (k === "/" && e.shiftKey)) {
        e.preventDefault();
        setHelp((v) => !v);
        return;
      }
      if (k === "o" || k === "O") {
        e.preventDefault();
        setOverview((v) => !v);
        return;
      }
      if (k === "f" || k === "F") {
        e.preventDefault();
        void toggleFullscreen();
        return;
      }
      if (overview || help) return;

      const step = (d: number) =>
        setIndex((i) => {
          const n = Math.max(0, Math.min(count - 1, i + d));
          if (n !== i) window.history.replaceState(null, "", `#${n + 1}`);
          return n;
        });

      if (k === "ArrowRight" || k === "PageDown" || k === "Enter" || k === "n") {
        e.preventDefault();
        step(1);
      } else if (k === " ") {
        // Space is also "scroll down" in the reflowed layout, where a slide can be taller than
        // the screen; taking it over there would strand the bottom of the slide.
        if (!flow) {
          e.preventDefault();
          step(1);
        }
      } else if (k === "ArrowLeft" || k === "PageUp" || k === "Backspace" || k === "p") {
        e.preventDefault();
        step(-1);
      } else if (k === "Home") {
        e.preventDefault();
        go(0);
      } else if (k === "End") {
        e.preventDefault();
        go(count - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overview, help, go, flow, count]);

  /* --------------------------------------------------------------- fullscreen */

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      // Fullscreen is a nicety; a browser that refuses it should not break the talk.
    }
  }

  useEffect(() => {
    const sync = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  /* ------------------------------------------------------------- idle fadeout */

  useEffect(() => {
    const wake = () => {
      setIdle(false);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => setIdle(true), IDLE_MS);
    };
    wake();
    window.addEventListener("mousemove", wake);
    window.addEventListener("keydown", wake);
    window.addEventListener("touchstart", wake);
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("keydown", wake);
      window.removeEventListener("touchstart", wake);
    };
  }, []);

  /* ------------------------------------------------------------------ gestures */

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start || overview || help) return;
    // No swipe navigation in the reflowed layout. A slide there is taller than the screen, so the
    // finger is already doing something on this surface, and no threshold cleanly separates "turn
    // the page" from "scroll at a slight angle" — the failure mode is losing your place mid-read,
    // which is worse than the gesture is worth. The bar at the foot of the screen is the control.
    if (flow) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < 44 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    go(index + (dx < 0 ? 1 : -1));
  };

  // The pointer only hides where clicking the backdrop advances the deck.
  const chromeHidden = idle && !flow && !overview && !help;
  // Over a scrolling page the controls need a surface of their own to stay legible.
  const pill = flow ? "rounded-full bg-background/85 shadow-sm backdrop-blur" : "";

  return (
    <div
      ref={rootRef}
      className={`deck-root relative w-full bg-background ${
        flow ? "h-[100dvh] overflow-y-auto overflow-x-hidden" : "h-[100dvh] overflow-hidden"
      } ${chromeHidden ? "cursor-none" : ""}`}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <DeckStyles />

      {/* Everything that renders a slide sits inside the provider — the stage and the overview
          thumbnails both contain diagrams that pick their labels from it. */}
      <DeckLangContext.Provider value={lang}>

      {/* The page's single light source, same gradient as the marketing site. */}
      <div
        aria-hidden="true"
        className="deck-glow pointer-events-none fixed left-1/2 top-[-14rem] h-[42rem] w-[54rem] max-w-[130vw] -translate-x-1/2 rounded-full bg-linear-to-br from-blue-500/20 to-violet-500/20 blur-[130px] dark:from-blue-500/15 dark:to-violet-500/15"
      />

      {/* ---------------------------------------------------------- the stage */}
      {flow ? (
        <div
          className={`deck-flow relative w-full ${lang === "zh" ? "deck-zh" : ""}`}
          lang={lang === "zh" ? "zh-Hans" : "en"}
        >
          {slides.map((slide, i) => (
            <div
              key={slide.id}
              id={`slide-${i + 1}`}
              className={`deck-slide ${i === index ? "block" : "hidden"}`}
            >
              {slide.node}
            </div>
          ))}
        </div>
      ) : (
        <div
          className="absolute inset-0 flex items-center justify-center"
          onClick={() => {
            if (!overview && !help) go(index + 1);
          }}
        >
          <div
            className={`deck-stage relative ${lang === "zh" ? "deck-zh" : ""}`}
            lang={lang === "zh" ? "zh-Hans" : "en"}
            style={{ width: W, height: H, transform: `scale(${layout.scale})` }}
          >
            {slides.map((slide, i) => (
              <div
                key={slide.id}
                id={`slide-${i + 1}`}
                className={`deck-slide absolute inset-0 transition-opacity duration-200 ${
                  i === index ? "opacity-100" : "pointer-events-none opacity-0"
                }`}
                aria-hidden={i === index ? undefined : true}
              >
                {slide.node}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- chrome */}
      <div
        className={`deck-chrome pointer-events-none ${
          flow ? "fixed" : "absolute"
        } inset-0 z-30 transition-opacity duration-500 ${chromeHidden ? "opacity-0" : "opacity-100"}`}
      >
        {/* brand, top left */}
        <Link
          href="/"
          onClick={(e) => e.stopPropagation()}
          className={`pointer-events-auto absolute left-3 top-3 flex items-center gap-2.5 px-2 py-1.5 text-black/50 transition-colors hover:text-black/80 dark:text-white/50 dark:hover:text-white/80 ${pill}`}
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-linear-to-br from-blue-500 to-violet-500 shadow-sm">
            <Sparkles className="h-3 w-3 text-white" aria-hidden="true" />
          </span>
          <span className="text-[13px] font-semibold tracking-tight">EverVault</span>
        </Link>

        {/* controls, top right */}
        <div
          className={`pointer-events-auto absolute right-3 top-3 flex items-center ${
            flow ? "gap-0.5 p-0.5" : "gap-1"
          } ${pill}`}
          onClick={(e) => e.stopPropagation()}
        >
          <LangButton lang={lang} onToggle={() => setLang((v) => (v === "en" ? "zh" : "en"))} />
          <ThemeButton />
          <IconButton label="Overview (O)" onClick={() => setOverview(true)}>
            <Grid2x2 size={16} />
          </IconButton>
          <IconButton label="Fullscreen (F)" onClick={() => void toggleFullscreen()}>
            {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
          </IconButton>
        </div>

        {/* counter + arrows, bottom right — desktop only; the phone gets the bar below. Rendered
            conditionally rather than hidden with a class: a `hidden` copy stays in the
            accessibility tree, so a screen reader would find two different controls both called
            "Next" and read both out. */}
        {flow ? null : (
        <div
          className="pointer-events-auto absolute bottom-3 right-3 flex items-center gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => setHelp(true)}
            className="mr-1 rounded-md px-2 py-1 font-mono text-[12px] text-black/40 transition-colors hover:text-black/70 dark:text-white/40 dark:hover:text-white/70"
            title="Shortcuts (?)"
          >
            ?
          </button>
          <span className="mr-1 font-mono text-[12px] tabular-nums text-black/45 dark:text-white/45">
            {index + 1} / {count}
          </span>
          <IconButton label="Previous" onClick={() => go(index - 1)} disabled={index === 0}>
            <ChevronLeft size={16} />
          </IconButton>
          <IconButton label="Next" onClick={() => go(index + 1)} disabled={index === last}>
            <ChevronRight size={16} />
          </IconButton>
        </div>
        )}

        {/* progress — desktop */}
        {flow ? null : (
          <div className="absolute bottom-0 left-0 h-[3px] w-full bg-black/[0.06] dark:bg-white/10">
            <div
              className="h-full bg-linear-to-r from-blue-500 to-violet-500 transition-[width] duration-200"
              style={{ width: `${((index + 1) / count) * 100}%` }}
            />
          </div>
        )}

        {/* ------------------------------------------------ phone navigation bar */}
        {flow ? (
          <div
            className="pointer-events-auto absolute inset-x-0 bottom-0 border-t border-black/10 bg-background/92 backdrop-blur dark:border-white/10"
            // Clears the iPhone home indicator, which otherwise sits on top of the buttons.
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
          >
            <div className="h-[3px] w-full bg-black/[0.06] dark:bg-white/10">
              <div
                className="h-full bg-linear-to-r from-blue-500 to-violet-500 transition-[width] duration-200"
                style={{ width: `${((index + 1) / count) * 100}%` }}
              />
            </div>
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              <NavButton
                side="prev"
                label={lang === "zh" ? "上一页" : "Prev"}
                disabled={index === 0}
                onClick={() => go(index - 1)}
              />
              {/* The counter doubles as the way into the grid — the fastest jump on a phone, and it
                  puts a third target in the middle of the bar where neither thumb has to stretch. */}
              <button
                type="button"
                onClick={() => setOverview(true)}
                className="flex h-12 flex-1 flex-col items-center justify-center rounded-xl text-black/55 transition active:bg-black/5 dark:text-white/55 dark:active:bg-white/10"
                aria-label={lang === "zh" ? "所有幻灯片" : "All slides"}
              >
                <span className="font-mono text-[15px] font-medium tabular-nums">
                  {index + 1} / {count}
                </span>
                <span className="text-[11px] opacity-60">
                  {lang === "zh" ? "全部" : "all slides"}
                </span>
              </button>
              <NavButton
                side="next"
                label={lang === "zh" ? "下一页" : "Next"}
                disabled={index === last}
                onClick={() => go(index + 1)}
              />
            </div>
          </div>
        ) : null}
      </div>

      {overview ? (
        <Overview
          index={index}
          slides={slides}
          lang={lang}
          thumb={layout.thumb}
          onPick={(i) => {
            go(i);
            setOverview(false);
          }}
          onClose={() => setOverview(false)}
        />
      ) : null}

      {help ? <Help onClose={() => setHelp(false)} flow={flow} /> : null}
      </DeckLangContext.Provider>
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

/**
 * EN / 中. A text toggle rather than an icon, because a globe says "there are languages" while
 * these two say which one you are about to get. The inactive side stays visible and dimmed so the
 * control reads as a two-position switch rather than a button whose effect you have to remember.
 */
function LangButton({ lang, onToggle }: { lang: DeckLang; onToggle: () => void }) {
  const label = lang === "en" ? "Switch to Chinese" : "切换到英文";
  return (
    <button
      type="button"
      onClick={onToggle}
      title={label}
      aria-label={label}
      className="flex items-center gap-1 rounded-md px-2 py-1.5 text-[12px] font-medium transition hover:bg-black/5 dark:hover:bg-white/10"
    >
      <span className={lang === "en" ? "text-black/80 dark:text-white/80" : "text-black/30 dark:text-white/30"}>
        EN
      </span>
      <span className="text-black/20 dark:text-white/20" aria-hidden="true">
        /
      </span>
      <span className={lang === "zh" ? "text-black/80 dark:text-white/80" : "text-black/30 dark:text-white/30"}>
        中
      </span>
    </button>
  );
}

const THEME_ICON = { light: Sun, dark: Moon, system: SunMoon } as const;
const THEME_LABEL: Record<ThemePreference, string> = {
  light: "Theme: light",
  dark: "Theme: dark",
  system: "Theme: system",
};

/**
 * The site's own ThemeToggle takes its label from the shared message catalogue, so on a site being
 * read in Chinese, Korean or Japanese its tooltip would come out in that language. The deck is an
 * English artefact in every one of those cases, so it drives the same ThemeProvider — same state,
 * same storage key, same cross-tab behaviour — behind its own fixed labels.
 */
function ThemeButton() {
  const { preference, mounted, toggle } = useTheme();
  // Before hydration the resolved preference is unknown; reserve the exact size instead of
  // guessing an icon and flashing the wrong one.
  if (!mounted) {
    return (
      <button type="button" className="p-2" aria-hidden="true" tabIndex={-1} disabled>
        <span className="block h-4 w-4" />
      </button>
    );
  }
  const Icon = THEME_ICON[preference];
  return (
    <IconButton label={THEME_LABEL[preference]} onClick={toggle}>
      <Icon size={16} />
    </IconButton>
  );
}

/**
 * A phone-sized navigation target. 48px tall and at least 104px wide, because the desktop icon
 * buttons are 32px squares in a corner — fine for a cursor, too small and too far for a thumb, and
 * swiping cannot be the answer when the same gesture axis is already scrolling the slide.
 */
function NavButton({
  side,
  label,
  disabled,
  onClick,
}: {
  side: "prev" | "next";
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="flex h-12 min-w-[104px] items-center justify-center gap-1.5 rounded-xl border border-black/10 bg-white/70 px-4 text-[15px] font-medium text-black/75 transition active:bg-black/[0.06] disabled:opacity-30 dark:border-white/10 dark:bg-white/5 dark:text-white/80 dark:active:bg-white/10"
    >
      {side === "prev" ? <ChevronLeft size={20} aria-hidden="true" /> : null}
      {label}
      {side === "next" ? <ChevronRight size={20} aria-hidden="true" /> : null}
    </button>
  );
}

function IconButton({
  children,
  label,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="rounded-md p-2 text-black/50 transition hover:bg-black/5 hover:text-black/80 disabled:opacity-25 disabled:hover:bg-transparent dark:text-white/50 dark:hover:bg-white/10 dark:hover:text-white/80"
    >
      {children}
    </button>
  );
}

/** Thumbnail grid. Each cell renders the real slide, scaled down, so what you pick is what you get.
 *  It lives outside `.deck-flow`, so the thumbnails keep the canvas type scale on every device. */
function Overview({
  index,
  slides,
  lang,
  thumb,
  onPick,
  onClose,
}: {
  index: number;
  slides: SlideDef[];
  lang: DeckLang;
  thumb: number;
  onPick: (i: number) => void;
  onClose: () => void;
}) {
  const t = thumb / W;
  return (
    <div
      className={`deck-chrome fixed inset-0 z-40 overflow-y-auto bg-white/85 backdrop-blur-md dark:bg-black/85 ${
        lang === "zh" ? "deck-zh" : ""
      }`}
      lang={lang === "zh" ? "zh-Hans" : "en"}
    >
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-black/10 bg-white/70 px-6 py-3 backdrop-blur dark:border-white/10 dark:bg-black/50">
        <span className="text-sm font-semibold tracking-tight">
          All slides
          <span className="ml-2 font-mono text-xs font-normal text-black/40 dark:text-white/40">
            {slides.length}
          </span>
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close overview"
          className="rounded-md p-2 text-black/50 transition hover:bg-black/5 dark:text-white/50 dark:hover:bg-white/10"
        >
          <X size={16} />
        </button>
      </div>

      <div className="mx-auto grid max-w-6xl grid-cols-2 gap-5 px-6 py-6 sm:grid-cols-3 lg:grid-cols-4">
        {slides.map((slide, i) => (
          <button
            key={slide.id}
            type="button"
            onClick={() => onPick(i)}
            className={`group text-left focus-visible:outline-none ${
              i === index ? "" : "opacity-80 hover:opacity-100"
            }`}
          >
            <div
              className={`overflow-hidden rounded-xl border bg-background shadow-sm transition ${
                i === index
                  ? "border-blue-500 ring-2 ring-blue-500/40"
                  : "border-black/10 group-hover:border-black/25 dark:border-white/10 dark:group-hover:border-white/25"
              }`}
              style={{ width: thumb, height: Math.round(H * t) }}
            >
              <div
                className="origin-top-left"
                style={{ width: W, height: H, transform: `scale(${t})` }}
              >
                {slide.node}
              </div>
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="font-mono text-[11px] text-black/40 dark:text-white/40">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="truncate text-[13px] text-black/65 dark:text-white/65">
                {slide.title}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function Help({ onClose, flow }: { onClose: () => void; flow: boolean }) {
  const rows: [React.ReactNode, string][] = [
    [
      <>
        <Kbd>→</Kbd> {flow ? null : <Kbd>Space</Kbd>}
      </>,
      "Next slide",
    ],
    [<Kbd key="l">←</Kbd>, "Previous slide"],
    [
      <>
        <Kbd>Home</Kbd> <Kbd>End</Kbd>
      </>,
      "First / last slide",
    ],
    [<Kbd key="o">O</Kbd>, "Overview of every slide"],
    [<Kbd key="f">F</Kbd>, "Fullscreen"],
    [<Kbd key="q">?</Kbd>, "This panel"],
  ];
  return (
    <div
      className="deck-chrome fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-full w-full max-w-md overflow-y-auto rounded-2xl border border-black/10 bg-white p-7 shadow-xl dark:border-white/10 dark:bg-[#111]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold tracking-tight">Shortcuts</h2>
        <dl className="mt-5 space-y-3">
          {rows.map(([keys, what], i) => (
            <div key={i} className="flex items-center justify-between gap-6">
              <dt className="flex gap-1.5">{keys}</dt>
              <dd className="text-sm text-black/55 dark:text-white/55">{what}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-6 border-t border-black/10 pt-4 text-xs leading-relaxed text-black/45 dark:border-white/10 dark:text-white/45">
          Any slide can be linked directly: add <span className="font-mono">#7</span> to the URL. On a
          narrow or upright screen the slides reflow into a scrollable reading layout with its own
          navigation bar, and wide diagrams scroll sideways on their own. Printing gives one slide per
          page, so switch to the light theme first if you want a PDF to hand out.
        </p>
        <button
          type="button"
          onClick={onClose}
          className="mt-5 w-full rounded-full bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
        >
          Close
        </button>
      </div>
    </div>
  );
}

/**
 * The two type scales, the reflow overrides, and the print sheet. Kept here rather than in
 * globals.css so the whole talk is one self-contained folder, and because the canvas scale and the
 * phone scale only make sense read next to each other.
 */
function DeckStyles() {
  return (
    <style>{`
      .dk-figure-hint { display: none; }

      .deck-root {
        --dk-h1: 62px;
        --dk-h2: 42px;
        --dk-lead: 23px;
        --dk-body: 19px;
        --dk-sm: 17px;
        --dk-xs: 15px;
        --dk-title: 21px;
        --dk-stat: 36px;
        --dk-mono: 13px;
        --dk-row-k: 18px;
        --dk-row-v: 17px;
      }

      /* Chinese needs its own steps. A CJK glyph is full-width, so the same pixel size reads
         noticeably larger and denser than Latin at the same value — matching the English scale
         literally would put 62px headlines over two lines on half the slides. Latin and digits
         inside Chinese text still render in Geist; only the ideographs fall through to the system
         face, which is what the stack below is for. */
      .deck-zh {
        --dk-h1: 52px;
        --dk-h2: 37px;
        --dk-lead: 21px;
        --dk-body: 18px;
        --dk-sm: 16px;
        --dk-xs: 14px;
        --dk-title: 20px;
        --dk-stat: 34px;
        --dk-mono: 12px;
        --dk-row-k: 17px;
        --dk-row-v: 16px;
        font-family: var(--font-geist-sans), "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
          "Noto Sans SC", "Source Han Sans SC", sans-serif;
      }

      /* Screen only: a print job always renders the canvas scale, whatever device started it. */
      @media screen {
        .deck-flow {
          --dk-h1: 30px;
          --dk-h2: 24px;
          --dk-lead: 17px;
          --dk-body: 16px;
          --dk-sm: 15px;
          --dk-xs: 13px;
          --dk-title: 17px;
          --dk-stat: 26px;
          --dk-mono: 12px;
          --dk-row-k: 16px;
          --dk-row-v: 14px;
        }
        /* A slide becomes a page: full width, at least a screen tall, content from the top, with
           room at either end for the fixed chrome. */
        .deck-flow .dk-frame {
          height: auto;
          min-height: 100dvh;
          /* top clears the floating chrome; bottom clears the navigation bar + the home indicator */
          padding: 68px 20px calc(112px + env(safe-area-inset-bottom));
          justify-content: flex-start;
        }
        /* Every two- and three-column grid inside a slide becomes one column. Scoped to .dk-frame
           so the overview grid, which is outside it, keeps its own columns. */
        .deck-flow .dk-frame .grid {
          grid-template-columns: 1fr !important;
          gap: 18px !important;
        }
        /* A grid item's automatic minimum size is its min-content width, so one wide child — the
           figure, which is deliberately wider than the phone — would widen the whole track and push
           its sibling column off the screen with it. The figure scrolls inside its own box; the
           track must not grow to fit it. */
        .deck-flow .dk-frame .grid > * {
          min-width: 0;
        }
        .deck-flow .dk-figure {
          overflow-x: auto;
          overscroll-behavior-x: contain;
          padding-bottom: 4px;
        }
        .deck-flow .dk-figure > svg {
          min-width: var(--dk-fig-min, 560px);
        }
        /* flow AND Chinese: two single-class rules would tie, and whichever came last would win
           outright — giving a phone the desktop Chinese scale, or Chinese the Latin phone scale.
           The compound selector settles it. */
        .deck-flow.deck-zh {
          --dk-h1: 26px;
          --dk-h2: 21px;
          --dk-lead: 16px;
          --dk-body: 15px;
          --dk-sm: 14px;
          --dk-xs: 12px;
          --dk-title: 16px;
          --dk-stat: 24px;
          --dk-mono: 11px;
          --dk-row-k: 15px;
          --dk-row-v: 13px;
        }
        .deck-flow .dk-figure-hint {
          display: block;
          margin-top: 6px;
          font-size: 12px;
          color: color-mix(in srgb, currentColor 45%, transparent);
        }
      }

      @media print {
        @page { size: 1280px 720px; margin: 0; }
        .deck-glow, .deck-chrome { display: none !important; }
        .deck-root {
          position: static !important;
          height: auto !important;
          overflow: visible !important;
        }
        .deck-root > div { position: static !important; display: block !important; }
        .deck-stage, .deck-flow {
          position: static !important;
          transform: none !important;
          width: auto !important;
          height: auto !important;
        }
        .deck-slide {
          display: block !important;
          position: relative !important;
          opacity: 1 !important;
          width: 1280px !important;
          height: 720px !important;
          break-after: page;
          page-break-after: always;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .deck-slide:last-child { break-after: auto; page-break-after: auto; }
        .dk-frame { height: 720px !important; padding: 60px 76px !important; }
      }
    `}</style>
  );
}
