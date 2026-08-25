// Presentation primitives for the /deck talk.
//
// SIZING. Every type size here is a CSS variable rather than a literal, because the deck has two
// layouts and they need two type scales. In canvas mode the slide is laid out against a constant
// 1280x720 box that is scaled as a whole to fit the screen, so sizes are absolute pixels on that
// box and a slide looks identical on any 16:9 (or 4:3, or 21:9) display. Below the width where
// that scaling would shrink body copy past legibility — a phone held upright — the deck switches
// to a reflowed, scrollable layout and the same variables are redefined smaller. Both scales live
// together in Deck.tsx, so changing one type step changes it in one place for both layouts.
//
// The alternative, plain responsive layout everywhere, is the wrong tool for a talk: a slide that
// reflows will reflow differently on the projector than it did on the laptop you rehearsed on, and
// you find out in front of the room.
//
// Colours reuse the marketing site's tokens so the deck and evervault.life read as one product.

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/* ---------------------------------------------------------------- layout */

/** The padded frame every slide lives in. `center` is for the title / section cards. */
export function Slide({
  children,
  center = false,
  className = "",
}: {
  children: ReactNode;
  center?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`dk-frame flex h-full w-full flex-col px-[76px] py-[60px] ${
        center ? "items-center justify-center text-center" : "justify-center"
      } ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * Two columns, text left / visual right by default. In the reflowed layout every grid inside a
 * slide collapses to one column (see the stylesheet in Deck.tsx), so `ratio` only applies while
 * there is room for two.
 */
export function Cols({
  children,
  ratio = "1fr 1fr",
  gap = 56,
  align = "center",
}: {
  children: ReactNode;
  ratio?: string;
  gap?: number;
  align?: "center" | "start";
}) {
  return (
    <div
      className="grid w-full"
      style={{ gridTemplateColumns: ratio, gap, alignItems: align === "center" ? "center" : "start" }}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------- typography */

/** The small pill above a heading — section marker, phase label, "on the roadmap".
 *  `w-fit` because as a flex item in Slide's column it would otherwise stretch the full width. */
export function Eyebrow({
  children,
  icon: Icon,
  tone = "blue",
}: {
  children: ReactNode;
  icon?: LucideIcon;
  tone?: "blue" | "violet" | "plain";
}) {
  const tones = {
    blue: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200",
    violet: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-200",
    plain:
      "border border-black/10 bg-black/[0.03] text-black/55 dark:border-white/10 dark:bg-white/5 dark:text-white/55",
  } as const;
  return (
    <span
      className={`inline-flex w-fit items-center gap-2 rounded-full px-[14px] py-[6px] text-[length:var(--dk-xs)] font-medium ${tones[tone]}`}
    >
      {Icon ? <Icon className="h-[1em] w-[1em]" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export function H1({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-balance text-[length:var(--dk-h1)] font-semibold leading-[1.04] tracking-tight">
      {children}
    </h2>
  );
}

export function H2({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-balance text-[length:var(--dk-h2)] font-semibold leading-[1.12] tracking-tight">
      {children}
    </h2>
  );
}

/** Gradient run of text — used for the second half of a two-part headline. */
export function Grad({ children }: { children: ReactNode }) {
  return (
    <span className="bg-linear-to-br from-blue-500 to-violet-500 bg-clip-text text-transparent">
      {children}
    </span>
  );
}

export function Lead({ children }: { children: ReactNode }) {
  return (
    <p className="text-pretty text-[length:var(--dk-lead)] leading-[1.5] text-black/60 dark:text-white/60">
      {children}
    </p>
  );
}

export function Body({ children }: { children: ReactNode }) {
  return (
    <p className="text-pretty text-[length:var(--dk-body)] leading-[1.55] text-black/60 dark:text-white/60">
      {children}
    </p>
  );
}

/** Inline monospace for identifiers, SQL fragments and file paths. */
export function Mono({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-[6px] bg-black/[0.06] px-[6px] py-[2px] font-mono text-[0.88em] text-black/75 dark:bg-white/10 dark:text-white/80">
      {children}
    </code>
  );
}

/**
 * An external link inside a slide. The click MUST stop propagating: the canvas treats a click
 * anywhere as "next slide", so without this, following a link would also turn the page under you —
 * you would come back from the new tab to a different slide than you left.
 */
export function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-baseline gap-[3px] text-blue-600 underline decoration-blue-600/30 underline-offset-[3px] transition-colors hover:decoration-blue-600 dark:text-blue-400 dark:decoration-blue-400/30 dark:hover:decoration-blue-400"
    >
      {children}
      <svg
        viewBox="0 0 24 24"
        className="h-[0.72em] w-[0.72em] self-center"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M7 17 17 7M9 7h8v8" />
      </svg>
    </a>
  );
}

/** A keycap, for the shortcut legend. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[26px] items-center justify-center rounded-[6px] border border-black/15 bg-white px-[7px] py-[3px] font-sans text-[13px] font-medium text-black/65 shadow-sm dark:border-white/15 dark:bg-white/10 dark:text-white/70">
      {children}
    </kbd>
  );
}

/* ------------------------------------------------------------------ lists */

/** Bulleted points with the site's gradient dot. Each item may be a string or JSX. */
export function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-[0.7em] text-[length:var(--dk-body)]">
      {items.map((item, i) => (
        <li key={i} className="flex gap-[0.7em]">
          <span
            className="mt-[0.62em] h-[7px] w-[7px] shrink-0 rounded-full bg-linear-to-br from-blue-500 to-violet-500"
            aria-hidden="true"
          />
          <span className="text-pretty leading-[1.5] text-black/70 dark:text-white/70">{item}</span>
        </li>
      ))}
    </ul>
  );
}

/** A numbered list — for the "four things that will bite you" style slides. */
export function Numbered({ items }: { items: { title: ReactNode; body: ReactNode }[] }) {
  return (
    <ol className="space-y-[0.8em] text-[length:var(--dk-body)]">
      {items.map((item, i) => (
        <li key={i} className="flex gap-[0.8em]">
          <span className="mt-[2px] flex h-[1.6em] w-[1.6em] shrink-0 items-center justify-center rounded-[10px] bg-linear-to-br from-blue-500 to-violet-500 text-[0.8em] font-semibold text-white shadow-sm">
            {i + 1}
          </span>
          <span className="leading-[1.5]">
            <span className="font-semibold">{item.title}</span>{" "}
            <span className="text-black/60 dark:text-white/60">{item.body}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------------ cards */

export function Card({
  icon: Icon,
  title,
  children,
  className = "",
}: {
  icon?: LucideIcon;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-[18px] border border-black/10 bg-white/70 p-[24px] shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5 ${className}`}
    >
      {Icon ? (
        <span className="mb-[14px] inline-flex h-[40px] w-[40px] items-center justify-center rounded-[12px] bg-linear-to-br from-blue-500 to-violet-500 shadow-sm">
          <Icon className="h-[19px] w-[19px] text-white" aria-hidden="true" />
        </span>
      ) : null}
      {title ? (
        <h3 className="text-[length:var(--dk-title)] font-semibold leading-tight tracking-tight">
          {title}
        </h3>
      ) : null}
      {children ? (
        <div className="mt-[8px] text-[length:var(--dk-sm)] leading-[1.5] text-black/60 dark:text-white/60">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** A big number with a caption underneath — the stat strip on the "what it is" slide. */
export function Stat({ value, label }: { value: ReactNode; label: ReactNode }) {
  return (
    <div>
      <div className="text-[length:var(--dk-stat)] font-semibold leading-none tracking-tight">
        <Grad>{value}</Grad>
      </div>
      <div className="mt-[8px] text-[length:var(--dk-xs)] leading-snug text-black/50 dark:text-white/50">
        {label}
      </div>
    </div>
  );
}

/** Pull-quote. `cite` is the source file, shown small and monospaced underneath. */
export function Quote({ children, cite }: { children: ReactNode; cite?: string }) {
  return (
    <figure className="border-l-[3px] border-blue-500/60 pl-[22px]">
      <blockquote className="text-pretty text-[length:var(--dk-title)] font-medium leading-[1.45] text-black/75 dark:text-white/80">
        {children}
      </blockquote>
      {cite ? (
        <figcaption className="mt-[10px] font-mono text-[length:var(--dk-mono)] text-black/40 dark:text-white/40">
          {cite}
        </figcaption>
      ) : null}
    </figure>
  );
}

/** The quiet strip at the bottom of a slide — a caveat, an aside, a "so what". */
export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="text-[length:var(--dk-sm)] leading-[1.5] text-black/45 dark:text-white/45">
      {children}
    </p>
  );
}

/** Small rounded chips, used for tool names and stack labels. */
export function Chips({ items }: { items: ReactNode[] }) {
  return (
    <div className="flex flex-wrap gap-[10px]">
      {items.map((label, i) => (
        <span
          key={i}
          className="rounded-full border border-black/10 bg-white/70 px-[14px] py-[6px] font-mono text-[length:var(--dk-xs)] text-black/60 backdrop-blur dark:border-white/10 dark:bg-white/5 dark:text-white/60"
        >
          {label}
        </span>
      ))}
    </div>
  );
}

/** A compact two-column key/value table for parameters and stack rows. */
export function Rows({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <div className="divide-y divide-black/10 dark:divide-white/10">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex items-baseline justify-between gap-[24px] py-[11px]">
          <span className="text-[length:var(--dk-row-k)] font-medium">{k}</span>
          <span className="text-right text-[length:var(--dk-row-v)] text-black/55 dark:text-white/55">
            {v}
          </span>
        </div>
      ))}
    </div>
  );
}
