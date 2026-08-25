// Inline SVG diagrams for the /deck talk. Inline rather than image files so they inherit the
// theme: every stroke and label uses a Tailwind fill-/stroke- utility, so the same markup reads
// correctly on a white projector and on a dark laptop. The blue-violet gradient is the one fixed
// colour — it is the product's, and it carries in both themes.
//
// Each diagram is drawn in its own coordinate space and scales with the slide canvas, so the
// numbers below are layout units, not pixels on any particular screen.

import type { CSSProperties, ReactNode } from "react";

/* ------------------------------------------------------------ shared bits */

const STROKE = "stroke-black/20 dark:stroke-white/20";
const BOX = "fill-white dark:fill-white/[0.07] stroke-black/12 dark:stroke-white/15";
const LABEL = "fill-black/75 dark:fill-white/75";
const MUTED = "fill-black/45 dark:fill-white/45";

function Defs() {
  return (
    <defs>
      <linearGradient id="dg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#3b82f6" />
        <stop offset="100%" stopColor="#8b5cf6" />
      </linearGradient>
      <marker
        id="dgArrow"
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerWidth="6"
        markerHeight="6"
        orient="auto-start-reverse"
      >
        <path d="M 0 0 L 10 5 L 0 10 z" className="fill-black/30 dark:fill-white/35" />
      </marker>
    </defs>
  );
}

/** A straight or elbowed connector with an arrowhead. */
function Arrow({ d, dashed = false }: { d: string; dashed?: boolean }) {
  return (
    <path
      d={d}
      fill="none"
      className={STROKE}
      strokeWidth={2}
      strokeDasharray={dashed ? "5 5" : undefined}
      markerEnd="url(#dgArrow)"
    />
  );
}

function Frame({ viewBox, children }: { viewBox: string; children: ReactNode }) {
  // A diagram scales with its column, and its labels scale with it. That is fine on the fixed
  // canvas, but in the reflowed layout the column can be 350px wide, which would put these 12px
  // labels at 4px. So the figure keeps a floor width there and scrolls sideways instead of
  // shrinking. The floor comes from the drawing's own coordinate width, so a wide diagram gets a
  // proportionally wide floor rather than one arbitrary number for all six.
  const vbWidth = Number.parseFloat(viewBox.split(/\s+/)[2]) || 1000;
  return (
    <div className="dk-figure-wrap">
      <div
        className="dk-figure"
        style={{ "--dk-fig-min": `${Math.round(vbWidth * 0.9)}px` } as CSSProperties}
      >
        <svg viewBox={viewBox} className="h-auto w-full" role="img">
          <Defs />
          {children}
        </svg>
      </div>
      {/* Hidden on the fixed canvas, where the whole diagram is always on screen. */}
      <span className="dk-figure-hint" aria-hidden="true">
        drag the diagram sideways to see all of it
      </span>
    </div>
  );
}

/* ------------------------------------------- 1. the model as a pure function */

/** text in -> model -> text out, with the three things it demonstrably cannot do. */
export function TextInTextOut() {
  return (
    <Frame viewBox="0 0 560 300">
      <rect x="6" y="86" width="126" height="60" rx="14" className={BOX} strokeWidth={1.5} />
      <text x="69" y="112" textAnchor="middle" className={`${LABEL} text-[15px] font-medium`}>
        prompt
      </text>
      <text x="69" y="132" textAnchor="middle" className={`${MUTED} font-mono text-[12px]`}>
        text
      </text>

      <Arrow d="M 140 116 L 208 116" />

      <rect x="216" y="66" width="128" height="100" rx="18" fill="url(#dg)" />
      <text x="280" y="106" textAnchor="middle" className="fill-white text-[16px] font-semibold">
        LLM
      </text>
      <text x="280" y="130" textAnchor="middle" className="fill-white/75 font-mono text-[12px]">
        stateless
      </text>

      <Arrow d="M 352 116 L 420 116" />

      <rect x="428" y="86" width="126" height="60" rx="14" className={BOX} strokeWidth={1.5} />
      <text x="491" y="112" textAnchor="middle" className={`${LABEL} text-[15px] font-medium`}>
        reply
      </text>
      <text x="491" y="132" textAnchor="middle" className={`${MUTED} font-mono text-[12px]`}>
        text
      </text>

      {/* what it cannot reach on its own */}
      <line x1="6" y1="206" x2="554" y2="206" className={STROKE} strokeWidth={1} strokeDasharray="4 6" />
      {["no memory", "no database", "no internet"].map((label, i) => (
        <g key={label} transform={`translate(${34 + i * 178} 236)`}>
          <circle cx="12" cy="12" r="12" className="fill-black/[0.05] dark:fill-white/[0.08]" />
          <path
            d="M 5 5 L 19 19 M 19 5 L 5 19"
            className="stroke-black/35 dark:stroke-white/40"
            strokeWidth={2}
            strokeLinecap="round"
          />
          <text x="34" y="17" className={`${MUTED} text-[15px]`}>
            {label}
          </text>
        </g>
      ))}
    </Frame>
  );
}

/* ------------------------------------------------- 2. the two RAG pathways */

/** Write path (conversation -> facts -> vectors) above, read path (question -> neighbours -> prompt) below. */
export function RagPaths() {
  const step = (x: number, y: number, w: number, label: string, sub?: string) => (
    <g key={`${x}-${y}`}>
      <rect x={x} y={y} width={w} height="56" rx="13" className={BOX} strokeWidth={1.5} />
      <text
        x={x + w / 2}
        y={sub ? y + 24 : y + 33}
        textAnchor="middle"
        className={`${LABEL} text-[14px] font-medium`}
      >
        {label}
      </text>
      {sub ? (
        <text x={x + w / 2} y={y + 42} textAnchor="middle" className={`${MUTED} font-mono text-[11px]`}>
          {sub}
        </text>
      ) : null}
    </g>
  );

  return (
    <Frame viewBox="0 0 1000 260">
      <text x="0" y="14" className={`${MUTED} font-mono text-[12px] uppercase tracking-[0.14em]`}>
        write · after the conversation
      </text>
      {step(0, 26, 176, "conversation", "20 turns")}
      <Arrow d="M 184 54 L 214 54" />
      {step(222, 26, 176, "extract facts", "one model call")}
      <Arrow d="M 406 54 L 436 54" />
      {step(444, 26, 176, "embed", "text → vector")}
      <Arrow d="M 628 54 L 658 54" />
      <rect x="666" y="26" width="176" height="56" rx="13" fill="url(#dg)" />
      <text x="754" y="50" textAnchor="middle" className="fill-white text-[14px] font-semibold">
        Postgres
      </text>
      <text x="754" y="68" textAnchor="middle" className="fill-white/75 font-mono text-[11px]">
        pgvector
      </text>

      {/* the store is shared by both paths */}
      <path
        d="M 754 90 L 754 132 L 754 150"
        fill="none"
        className={STROKE}
        strokeWidth={2}
        markerEnd="url(#dgArrow)"
      />

      <text x="0" y="152" className={`${MUTED} font-mono text-[12px] uppercase tracking-[0.14em]`}>
        read · every single turn
      </text>
      {step(0, 164, 176, "your question", "text")}
      <Arrow d="M 184 192 L 214 192" />
      {step(222, 164, 176, "embed", "same model")}
      <Arrow d="M 406 192 L 436 192" />
      {step(444, 164, 176, "nearest neighbours", "top 6")}
      <Arrow d="M 628 192 L 658 192" />
      {step(666, 164, 176, "into the prompt", "as grounding")}
      <Arrow d="M 850 192 L 890 192" />
      <rect x="898" y="164" width="102" height="56" rx="13" fill="url(#dg)" />
      <text x="949" y="197" textAnchor="middle" className="fill-white text-[14px] font-semibold">
        answer
      </text>
    </Frame>
  );
}

/* ------------------------------------------------------ 3. embedding space */

/** A 2-D stand-in for a 1536-D space: related notes cluster, the query lands among them. */
export function EmbeddingSpace() {
  const notes: { x: number; y: number; label: string }[] = [
    { x: 168, y: 86, label: "coast trip in spring" },
    { x: 232, y: 156, label: "booked the cottage" },
    { x: 150, y: 178, label: "packed the tent" },
    { x: 390, y: 76, label: "renewed my passport" },
    { x: 404, y: 200, label: "dentist on Thursday" },
    { x: 322, y: 272, label: "learning Go" },
  ];
  const q = { x: 196, y: 132 };
  const r = 82;
  return (
    <Frame viewBox="0 0 560 330">
      {/* the neighbourhood the query pulls back */}
      <circle
        cx={q.x}
        cy={q.y}
        r={r}
        className="fill-blue-500/[0.07] stroke-blue-500/30"
        strokeWidth={1.5}
        strokeDasharray="5 5"
      />

      {notes.map((n) => {
        const near = Math.hypot(n.x - q.x, n.y - q.y) < r;
        return (
          <g key={n.label}>
            {near ? (
              <line x1={q.x} y1={q.y} x2={n.x} y2={n.y} className="stroke-blue-500/35" strokeWidth={1.5} />
            ) : null}
            <circle
              cx={n.x}
              cy={n.y}
              r="6"
              className={near ? "fill-blue-500" : "fill-black/25 dark:fill-white/30"}
            />
            <text x={n.x + 12} y={n.y + 5} className={`${near ? LABEL : MUTED} text-[14px]`}>
              {n.label}
            </text>
          </g>
        );
      })}

      <circle cx={q.x} cy={q.y} r="9" fill="url(#dg)" />
      <circle cx={q.x} cy={q.y} r="14" className="fill-none stroke-violet-500/50" strokeWidth={2} />

      {/* The query's own caption sits clear of the cluster, on a leader, so it never lands on a note. */}
      <line
        x1={q.x}
        y1={q.y + 16}
        x2={q.x}
        y2={q.y + 108}
        className="stroke-violet-500/40"
        strokeWidth={1.5}
        strokeDasharray="3 4"
      />
      <text x={q.x} y={q.y + 126} textAnchor="middle" className={`${LABEL} text-[14px] font-semibold`}>
        &ldquo;that seaside trip?&rdquo;
      </text>

      <text x="0" y="322" className={`${MUTED} font-mono text-[12px]`}>
        1536 dimensions, drawn in 2 · distance = cosine
      </text>
    </Frame>
  );
}

/* ------------------------------------------------- 4. three lanes, one list */

/** Vector / full-text / trigram each rank independently; RRF fuses the ranks. */
export function ThreeLanes() {
  const lanes = [
    { label: "vector", sub: "meaning · HNSW cosine", y: 20 },
    { label: "full-text", sub: "words · GIN tsvector", y: 100 },
    { label: "trigram", sub: "fragments, typos · pg_trgm", y: 180 },
  ];
  return (
    <Frame viewBox="0 0 1000 268">
      {lanes.map((l) => (
        <g key={l.label}>
          <rect x="0" y={l.y} width="288" height="62" rx="14" className={BOX} strokeWidth={1.5} />
          <text x="24" y={l.y + 27} className={`${LABEL} text-[16px] font-semibold`}>
            {l.label}
          </text>
          <text x="24" y={l.y + 48} className={`${MUTED} font-mono text-[12px]`}>
            {l.sub}
          </text>
          <text x="266" y={l.y + 38} textAnchor="end" className={`${MUTED} font-mono text-[12px]`}>
            top 50
          </text>
          <Arrow d={`M 296 ${l.y + 31} L 386 ${l.y + 31} L 420 ${l.y + 31}`} />
        </g>
      ))}

      <rect x="428" y="70" width="212" height="122" rx="18" fill="url(#dg)" />
      <text x="534" y="116" textAnchor="middle" className="fill-white text-[17px] font-semibold">
        RRF
      </text>
      <text x="534" y="142" textAnchor="middle" className="fill-white/80 font-mono text-[13px]">
        1 / (60 + rank)
      </text>
      <text x="534" y="164" textAnchor="middle" className="fill-white/70 font-mono text-[11px]">
        summed per document
      </text>

      <Arrow d="M 648 131 L 716 131" />

      <rect x="724" y="70" width="276" height="122" rx="18" className={BOX} strokeWidth={1.5} />
      <text x="748" y="104" className={`${LABEL} text-[16px] font-semibold`}>
        one fused list
      </text>
      <text x="748" y="130" className={`${MUTED} text-[14px]`}>
        re-rank: recency, dedupe, cutoff
      </text>
      <text x="748" y="156" className={`${MUTED} text-[14px]`}>
        keep 6 → into the system prompt
      </text>

      <text x="0" y="258" className={`${MUTED} font-mono text-[12px]`}>
        fused by RANK, not by score — a cosine distance and a ts_rank have no exchange rate
      </text>
    </Frame>
  );
}

/* --------------------------------------------------- 5. the tool-call loop */

/** The model asks; your code acts; the result goes back in. Repeat until it writes prose. */
export function ToolLoop() {
  return (
    <Frame viewBox="0 0 560 330">
      <rect x="150" y="6" width="260" height="66" rx="16" fill="url(#dg)" />
      <text x="280" y="34" textAnchor="middle" className="fill-white text-[16px] font-semibold">
        model
      </text>
      <text x="280" y="55" textAnchor="middle" className="fill-white/75 font-mono text-[12px]">
        + tool declarations
      </text>

      {/* ask */}
      <Arrow d="M 410 42 L 470 42 L 470 150 L 410 150" />
      <text x="482" y="98" className={`${MUTED} text-[13px]`} textAnchor="start">
        asks
      </text>

      <rect x="150" y="120" width="260" height="66" rx="16" className={BOX} strokeWidth={1.5} />
      <text x="280" y="148" textAnchor="middle" className={`${LABEL} text-[15px] font-medium`}>
        functionCall
      </text>
      <text x="280" y="169" textAnchor="middle" className={`${MUTED} font-mono text-[12px]`}>
        {"{ name, args }"}
      </text>

      <Arrow d="M 280 194 L 280 226" />

      <rect x="70" y="234" width="420" height="66" rx="16" className={BOX} strokeWidth={1.5} />
      <text x="280" y="262" textAnchor="middle" className={`${LABEL} text-[15px] font-semibold`}>
        your code runs it
      </text>
      <text x="280" y="283" textAnchor="middle" className={`${MUTED} font-mono text-[12px]`}>
        HTTP · SQL · filesystem · anything
      </text>

      {/* result back */}
      <Arrow d="M 70 267 L 34 267 L 34 42 L 142 42" />
      <text x="46" y="160" className={`${MUTED} text-[13px]`}>
        result
      </text>
    </Frame>
  );
}

/* --------------------------------------------------------- 6. the topology */

/** One host, one domain: nginx in front, a disposable app container, a database that never stops. */
export function Architecture() {
  return (
    <Frame viewBox="0 0 1000 300">
      <rect x="0" y="14" width="220" height="54" rx="13" className={BOX} strokeWidth={1.5} />
      <text x="110" y="46" textAnchor="middle" className={`${LABEL} text-[15px] font-medium`}>
        Cloudflare · TLS
      </text>
      <Arrow d="M 110 74 L 110 108" />

      {/* app container */}
      <rect
        x="0"
        y="116"
        width="620"
        height="164"
        rx="20"
        className="fill-black/[0.02] stroke-black/12 dark:fill-white/[0.03] dark:stroke-white/15"
        strokeWidth={1.5}
        strokeDasharray="6 6"
      />
      <text x="22" y="142" className={`${MUTED} font-mono text-[12px] uppercase tracking-[0.14em]`}>
        app container · disposable
      </text>

      <rect x="22" y="154" width="176" height="104" rx="14" className={BOX} strokeWidth={1.5} />
      <text x="110" y="196" textAnchor="middle" className={`${LABEL} text-[15px] font-semibold`}>
        nginx
      </text>
      <text x="110" y="218" textAnchor="middle" className={`${MUTED} font-mono text-[12px]`}>
        :38378
      </text>

      <Arrow d="M 206 182 L 262 182" />
      <Arrow d="M 206 230 L 262 230" />
      <text x="216" y="174" className={`${MUTED} font-mono text-[11px]`}>
        {"/api/*"}
      </text>
      <text x="216" y="222" className={`${MUTED} font-mono text-[11px]`}>
        {"/*"}
      </text>

      <rect x="270" y="154" width="176" height="52" rx="13" className={BOX} strokeWidth={1.5} />
      <text x="358" y="185" textAnchor="middle" className={`${LABEL} text-[14px] font-medium`}>
        .NET 10 · :38372
      </text>

      <rect x="270" y="212" width="176" height="52" rx="13" className={BOX} strokeWidth={1.5} />
      <text x="358" y="243" textAnchor="middle" className={`${LABEL} text-[14px] font-medium`}>
        Next.js 16 · :38373
      </text>

      <Arrow d="M 454 180 L 700 180" />
      <text x="530" y="170" className={`${MUTED} font-mono text-[11px]`}>
        :5432 · trust auth, never exposed
      </text>

      <rect x="708" y="130" width="292" height="136" rx="20" fill="url(#dg)" />
      <text x="854" y="180" textAnchor="middle" className="fill-white text-[17px] font-semibold">
        Postgres 18 + pgvector
      </text>
      <text x="854" y="206" textAnchor="middle" className="fill-white/80 text-[13px]">
        memories · files · config · secrets
      </text>
      <text x="854" y="230" textAnchor="middle" className="fill-white/70 font-mono text-[12px]">
        own container · never restarts
      </text>
    </Frame>
  );
}
