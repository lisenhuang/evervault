"use client";

// Inline SVG diagrams for the /deck talk. Inline rather than image files so they inherit two things
// they could not inherit as assets: the theme (every stroke and label uses a Tailwind fill-/stroke-
// utility, so the same markup reads correctly on a white projector and a dark laptop) and the
// language (labels come from useDeckLabel, so they switch with the prose). The blue-violet gradient
// is the one fixed colour — it is the product's, and it carries in both themes.
//
// Each diagram is drawn in its own coordinate space and scales with the slide canvas, so the
// numbers below are layout units, not pixels on any particular screen. Coordinates are shared
// between languages; Chinese labels are shorter than their English counterparts in nearly every
// case, so a layout that fits in English fits in Chinese.

import type { CSSProperties, ReactNode } from "react";
import { useDeckLabel } from "./lang";

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
  const l = useDeckLabel();
  return (
    <Frame viewBox="0 0 560 300">
      <rect x="6" y="86" width="126" height="60" rx="14" className={BOX} strokeWidth={1.5} />
      <text x="69" y="112" textAnchor="middle" className={`${LABEL} text-[15px] font-medium`}>
        {l("prompt", "提示词")}
      </text>
      <text x="69" y="132" textAnchor="middle" className={`${MUTED} font-mono text-[12px]`}>
        {l("text", "文本")}
      </text>

      <Arrow d="M 140 116 L 208 116" />

      <rect x="216" y="66" width="128" height="100" rx="18" fill="url(#dg)" />
      <text x="280" y="106" textAnchor="middle" className="fill-white text-[16px] font-semibold">
        {l("LLM", "大模型")}
      </text>
      <text x="280" y="130" textAnchor="middle" className="fill-white/75 font-mono text-[12px]">
        {l("stateless", "无状态")}
      </text>

      <Arrow d="M 352 116 L 420 116" />

      <rect x="428" y="86" width="126" height="60" rx="14" className={BOX} strokeWidth={1.5} />
      <text x="491" y="112" textAnchor="middle" className={`${LABEL} text-[15px] font-medium`}>
        {l("reply", "回复")}
      </text>
      <text x="491" y="132" textAnchor="middle" className={`${MUTED} font-mono text-[12px]`}>
        {l("text", "文本")}
      </text>

      {/* what it cannot reach on its own */}
      <line x1="6" y1="206" x2="554" y2="206" className={STROKE} strokeWidth={1} strokeDasharray="4 6" />
      {[
        l("no memory", "没有记忆"),
        l("no database", "没有数据库"),
        l("no internet", "没有网络"),
      ].map((label, i) => (
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
  const l = useDeckLabel();
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
        {l("write · after the conversation", "写入 · 对话之后")}
      </text>
      {step(0, 26, 176, l("conversation", "一段对话"), l("20 turns", "20 轮"))}
      <Arrow d="M 184 54 L 214 54" />
      {step(222, 26, 176, l("extract facts", "抽取事实"), l("one model call", "一次模型调用"))}
      <Arrow d="M 406 54 L 436 54" />
      {step(444, 26, 176, l("embed", "向量化"), l("text → vector", "文本 → 向量"))}
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
        {l("read · every single turn", "读取 · 每一轮")}
      </text>
      {step(0, 164, 176, l("your question", "你的问题"), l("text", "文本"))}
      <Arrow d="M 184 192 L 214 192" />
      {step(222, 164, 176, l("embed", "向量化"), l("same model", "同一个模型"))}
      <Arrow d="M 406 192 L 436 192" />
      {step(444, 164, 176, l("nearest neighbours", "最近邻"), l("top 6", "取 6 条"))}
      <Arrow d="M 628 192 L 658 192" />
      {step(666, 164, 176, l("into the prompt", "注入提示词"), l("as grounding", "作为事实依据"))}
      <Arrow d="M 850 192 L 890 192" />
      <rect x="898" y="164" width="102" height="56" rx="13" fill="url(#dg)" />
      <text x="949" y="197" textAnchor="middle" className="fill-white text-[14px] font-semibold">
        {l("answer", "回答")}
      </text>
    </Frame>
  );
}

/* ------------------------------------------------------ 3. embedding space */

/** A 2-D stand-in for a 1536-D space: related notes cluster, the query lands among them. */
export function EmbeddingSpace() {
  const l = useDeckLabel();
  const notes: { x: number; y: number; label: string }[] = [
    { x: 168, y: 86, label: l("coast trip in spring", "春天的海边旅行") },
    { x: 232, y: 156, label: l("booked the cottage", "订了那间小屋") },
    { x: 150, y: 178, label: l("packed the tent", "收好了帐篷") },
    { x: 390, y: 76, label: l("renewed my passport", "换了新护照") },
    { x: 404, y: 200, label: l("dentist on Thursday", "周四看牙医") },
    { x: 322, y: 272, label: l("learning Go", "在学 Go") },
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
        {l("“that seaside trip?”", "“那次海边旅行？”")}
      </text>

      <text x="0" y="322" className={`${MUTED} font-mono text-[12px]`}>
        {l("1536 dimensions, drawn in 2 · distance = cosine", "1536 维，这里画成 2 维 · 距离用余弦")}
      </text>
    </Frame>
  );
}

/* ------------------------------------- 3b. two spaces that cannot be compared */

/**
 * A 2-D vector beside a 3-D one, drawn in deliberately identical style — same axis length, same
 * arrow, same decomposition dashes — so the ONLY visible difference is the number of axes. That is
 * the argument: nothing about these two is incompatible except their width, and their width is
 * enough. The first two components are even printed the same, to head off the obvious
 * "but couldn't you just pad it?" — same numbers, still no shared space to measure in.
 *
 * 2 against 3 is what fits on a slide; the real pair is 768 against 1536.
 */
export function DimensionMismatch() {
  const l = useDeckLabel();

  const AX = "stroke-black/30 dark:stroke-white/35";
  const DASH = "stroke-black/20 dark:stroke-white/25";
  const VEC = "stroke-blue-500";
  const VECFILL = "fill-blue-500";

  return (
    <Frame viewBox="0 0 560 320">
      {/* ---------------------------------------------------------- 2-D, left */}
      <text x="78" y="16" className={`${MUTED} font-mono text-[12px] uppercase tracking-[0.12em]`}>
        {l("model A · 2 dimensions", "模型 A · 2 维")}
      </text>

      <line x1="78" y1="190" x2="188" y2="190" className={AX} strokeWidth={1.5} />
      <line x1="78" y1="190" x2="78" y2="80" className={AX} strokeWidth={1.5} />
      <line x1="146" y1="126" x2="146" y2="190" className={DASH} strokeWidth={1.25} strokeDasharray="3 4" />
      <line x1="146" y1="126" x2="78" y2="126" className={DASH} strokeWidth={1.25} strokeDasharray="3 4" />
      <line x1="78" y1="190" x2="146" y2="126" className={VEC} strokeWidth={2.5} />
      <path d="M 146 126 L 140.7 137.8 L 133.9 130.6 Z" className={VECFILL} />
      <circle cx="78" cy="190" r="3" className="fill-black/40 dark:fill-white/45" />

      <text x="78" y="246" className={`${LABEL} font-mono text-[13px]`}>
        [ 0.42, −0.13 ]
      </text>

      {/* ---------------------------------------------------------- 3-D, right */}
      <text x="392" y="16" className={`${MUTED} font-mono text-[12px] uppercase tracking-[0.12em]`}>
        {l("model B · 3 dimensions", "模型 B · 3 维")}
      </text>

      <line x1="392" y1="190" x2="502" y2="190" className={AX} strokeWidth={1.5} />
      <line x1="392" y1="190" x2="392" y2="80" className={AX} strokeWidth={1.5} />
      {/* the third axis, angled toward the viewer — the whole difference between the two panels */}
      <line x1="392" y1="190" x2="345" y2="224" className={AX} strokeWidth={1.5} />
      <line x1="392" y1="190" x2="460" y2="190" className={DASH} strokeWidth={1.25} strokeDasharray="3 4" />
      <line x1="460" y1="190" x2="436.5" y2="207" className={DASH} strokeWidth={1.25} strokeDasharray="3 4" />
      <line x1="436.5" y1="207" x2="436.5" y2="143" className={DASH} strokeWidth={1.25} strokeDasharray="3 4" />
      <line x1="392" y1="190" x2="436.5" y2="143" className={VEC} strokeWidth={2.5} />
      <path d="M 436.5 143 L 431.8 155.1 L 424.6 148.3 Z" className={VECFILL} />
      <circle cx="392" cy="190" r="3" className="fill-black/40 dark:fill-white/45" />

      <text x="392" y="246" className={`${LABEL} font-mono text-[13px]`}>
        [ 0.42, −0.13, 0.77 ]
      </text>

      {/* --------------------------------------------- the operation that cannot run */}
      <line x1="0" y1="266" x2="560" y2="266" className={STROKE} strokeWidth={1} strokeDasharray="4 6" />
      <g transform="translate(150 282)">
        <circle cx="11" cy="11" r="11" className="fill-black/[0.05] dark:fill-white/[0.08]" />
        <path
          d="M 5 5 L 17 17 M 17 5 L 5 17"
          className="stroke-black/40 dark:stroke-white/45"
          strokeWidth={2}
          strokeLinecap="round"
        />
        <text x="32" y="16" className={`${LABEL} font-mono text-[14px]`}>
          cosine( a, b )
        </text>
        <text x="152" y="16" className={`${MUTED} text-[13px]`}>
          {l("no shared space to measure in", "没有一个共同的空间可以度量")}
        </text>
      </g>

      <text x="0" y="316" className={`${MUTED} font-mono text-[11px]`}>
        {l(
          "2 against 3 here · 768 against 1536 in the code · the same error",
          "这里是 2 对 3 · 代码里是 768 对 1536 · 同一个报错",
        )}
      </text>
    </Frame>
  );
}

/* ------------------------------------------------- 4. three lanes, one list */

/** Vector / full-text / trigram each rank independently; RRF fuses the ranks. */
export function ThreeLanes() {
  const l = useDeckLabel();
  const lanes = [
    { label: l("vector", "向量"), sub: l("meaning · HNSW cosine", "语义 · HNSW 余弦"), y: 20 },
    { label: l("full-text", "全文"), sub: l("words · GIN tsvector", "词 · GIN tsvector"), y: 100 },
    { label: l("trigram", "三元组"), sub: l("fragments, typos · pg_trgm", "片段、错字 · pg_trgm"), y: 180 },
  ];
  return (
    <Frame viewBox="0 0 1000 268">
      {lanes.map((lane) => (
        <g key={lane.label}>
          <rect x="0" y={lane.y} width="288" height="62" rx="14" className={BOX} strokeWidth={1.5} />
          <text x="24" y={lane.y + 27} className={`${LABEL} text-[16px] font-semibold`}>
            {lane.label}
          </text>
          <text x="24" y={lane.y + 48} className={`${MUTED} font-mono text-[12px]`}>
            {lane.sub}
          </text>
          <text x="266" y={lane.y + 38} textAnchor="end" className={`${MUTED} font-mono text-[12px]`}>
            {l("top 50", "前 50")}
          </text>
          <Arrow d={`M 296 ${lane.y + 31} L 386 ${lane.y + 31} L 420 ${lane.y + 31}`} />
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
        {l("summed per document", "按文档累加")}
      </text>

      <Arrow d="M 648 131 L 716 131" />

      <rect x="724" y="70" width="276" height="122" rx="18" className={BOX} strokeWidth={1.5} />
      <text x="748" y="104" className={`${LABEL} text-[16px] font-semibold`}>
        {l("one fused list", "融合成一个列表")}
      </text>
      <text x="748" y="130" className={`${MUTED} text-[14px]`}>
        {l("re-rank: recency, dedupe, cutoff", "重排：时效、去重、阈值")}
      </text>
      <text x="748" y="156" className={`${MUTED} text-[14px]`}>
        {l("keep 6 → into the system prompt", "留 6 条 → 进系统指令")}
      </text>

      <text x="0" y="258" className={`${MUTED} font-mono text-[12px]`}>
        {l(
          "fused by RANK, not by score — a cosine distance and a ts_rank have no exchange rate",
          "按名次融合，不按分数 — 余弦距离和 ts_rank 之间没有汇率",
        )}
      </text>
    </Frame>
  );
}

/* --------------------------------------- 1b. the same picture, one tier up */

/**
 * Deliberately the same composition as TextInTextOut — same viewBox, same box coordinates, same
 * divider, same row of three at the foot — so that when it appears the audience recognises the
 * shape before they read a word, and the only thing that has changed is what is IN it. One input
 * becomes three, one output becomes three, and the row of crosses becomes a row of ticks.
 */
export function LiveModelIO() {
  const l = useDeckLabel();
  const chip = (x: number, y: number, label: string, sub?: string) => (
    <g key={`${x}-${y}`}>
      <rect x={x} y={y} width="126" height="40" rx="11" className={BOX} strokeWidth={1.5} />
      <text
        x={x + 63}
        y={sub ? y + 18 : y + 25}
        textAnchor="middle"
        className={`${LABEL} text-[13px] font-medium`}
      >
        {label}
      </text>
      {sub ? (
        <text x={x + 63} y={y + 32} textAnchor="middle" className={`${MUTED} font-mono text-[10px]`}>
          {sub}
        </text>
      ) : null}
    </g>
  );

  return (
    <Frame viewBox="0 0 560 300">
      {chip(6, 46, l("audio", "音频"), "16 kHz")}
      {chip(6, 98, l("image", "图片"), "JPEG")}
      {chip(6, 150, l("text", "文本"))}

      <Arrow d="M 140 118 L 208 118" />

      <rect x="216" y="66" width="128" height="100" rx="18" fill="url(#dg)" />
      <text x="280" y="106" textAnchor="middle" className="fill-white text-[16px] font-semibold">
        {l("Live model", "Live 模型")}
      </text>
      <text x="280" y="130" textAnchor="middle" className="fill-white/75 font-mono text-[11px]">
        {l("native audio", "原生音频")}
      </text>

      <Arrow d="M 352 118 L 420 118" />

      {chip(428, 46, l("audio", "音频"), "24 kHz")}
      {chip(428, 98, l("your transcript", "你的转写"))}
      {chip(428, 150, l("its transcript", "它的转写"))}

      {/* the row that was three crosses, one slide ago */}
      <line x1="6" y1="206" x2="554" y2="206" className={STROKE} strokeWidth={1} strokeDasharray="4 6" />
      {[
        l("hears tone, not a transcript", "听见语气，不是转写稿"),
        l("sees the image itself", "直接看见那张图"),
        l("answers before you finish", "你没说完就能答"),
      ].map((label, i) => (
        <g key={label} transform={`translate(24 ${222 + i * 26})`}>
          <circle cx="9" cy="9" r="9" className="fill-blue-500/15" />
          <path
            d="M 5 9.5 L 8 12.5 L 13.5 6"
            fill="none"
            className="stroke-blue-600 dark:stroke-blue-400"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <text x="28" y="14" className={`${LABEL} text-[13px]`}>
            {label}
          </text>
        </g>
      ))}
    </Frame>
  );
}

/* ------------------------------------- 4b. two ways to answer a spoken turn */

/**
 * The same spoken turn on one time axis, twice. Drawn as a timeline rather than a flowchart because
 * the point is not the boxes, it is WHEN they happen: with a text-only model every stage waits for
 * the one before it and none of them start until you stop talking, so first sound lands at the far
 * right. With a native audio model the model is already working while you are still speaking, so the
 * "you stop speaking" marker and first sound are almost the same instant.
 */
export function VoicePipelines() {
  const l = useDeckLabel();
  const STOP = 340;

  const seg = (
    x: number,
    w: number,
    y: number,
    h: number,
    label: string,
    tone: "plain" | "warm" | "grad",
  ) => (
    <g key={`${x}-${y}-${label}`}>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx="8"
        {...(tone === "grad"
          ? { fill: "url(#dg)" }
          : {
              className:
                tone === "warm"
                  ? "fill-blue-500/12 stroke-blue-500/35"
                  : "fill-black/[0.04] stroke-black/15 dark:fill-white/[0.06] dark:stroke-white/20",
              strokeWidth: 1.25,
            })}
      />
      <text
        x={x + w / 2}
        y={y + h / 2 + 4}
        textAnchor="middle"
        className={
          tone === "grad" ? "fill-white text-[12px] font-medium" : `${LABEL} text-[12px]`
        }
      >
        {label}
      </text>
    </g>
  );

  /** A caret plus a label marking the instant the listener first hears something. */
  const firstSound = (x: number, y: number, text: string, strong: boolean) => (
    <g>
      <path
        d={`M ${x - 6} ${y + 11} L ${x} ${y + 2} L ${x + 6} ${y + 11} Z`}
        className={strong ? "fill-violet-500" : "fill-black/35 dark:fill-white/40"}
      />
      <text
        x={x}
        y={y + 26}
        textAnchor="middle"
        className={`${strong ? "fill-violet-600 dark:fill-violet-300" : MUTED} text-[12px] font-medium`}
      >
        {text}
      </text>
    </g>
  );

  return (
    <Frame viewBox="0 0 1000 244">
      {/* the shared instant both rows are measured against */}
      <line
        x1={STOP}
        y1="16"
        x2={STOP}
        y2="206"
        className="stroke-black/25 dark:stroke-white/30"
        strokeWidth={1.5}
        strokeDasharray="4 4"
      />
      <text x={STOP + 8} y="12" className={`${LABEL} text-[12px] font-semibold`}>
        {l("you stop speaking", "你说完了")}
      </text>

      {/* ---- row 1: a text-only model, five stages, none of them overlapping ---- */}
      <text x="0" y="34" className={`${MUTED} font-mono text-[11px] uppercase tracking-[0.14em]`}>
        {l("text-only model · each stage waits for the last", "纯文本模型 · 每一段都在等上一段")}
      </text>
      {seg(0, 340, 42, 38, l("you speak", "你说话"), "plain")}
      {seg(340, 100, 42, 38, l("upload", "上传"), "plain")}
      {seg(440, 160, 42, 38, l("transcribe", "转写"), "plain")}
      {seg(600, 190, 42, 38, l("model", "模型"), "plain")}
      {seg(790, 150, 42, 38, l("synthesize", "合成"), "plain")}
      {firstSound(940, 80, l("first sound", "第一声"), false)}

      {/* ---- row 2: a native audio model, overlapping because it hears you live ---- */}
      <text x="0" y="122" className={`${MUTED} font-mono text-[11px] uppercase tracking-[0.14em]`}>
        {l("native audio model · one streaming session", "原生音频模型 · 一条流式会话")}
      </text>
      {seg(0, 340, 130, 32, l("you speak · streaming", "你说话 · 边说边传"), "warm")}
      {seg(200, 190, 168, 32, l("reasoning · calling tools", "推理 · 调用工具"), "warm")}
      {seg(390, 170, 168, 32, l("spoken reply", "语音回复"), "grad")}
      {firstSound(390, 200, l("first sound", "第一声"), true)}
      {/* The tool round-trip is the part that surprises people: it completes before the user has
          finished the sentence that prompted it. */}
      <text x="204" y="178" className={`${MUTED} font-mono text-[11px]`}>
        {l("recall_memory · search_web — answered before you finish", "recall_memory · search_web — 你还没说完就已经返回")}
      </text>

      <text x="600" y="222" className={`${MUTED} font-mono text-[11px]`}>
        {l(
          "same turn, same axis — the difference is overlap, not speed",
          "同一轮，同一条时间轴 — 差别在于重叠，不是快慢",
        )}
      </text>
    </Frame>
  );
}

/* --------------------------------------------------- 5. the tool-call loop */

/** The model asks; your code acts; the result goes back in. Repeat until it writes prose. */
export function ToolLoop() {
  const l = useDeckLabel();
  return (
    <Frame viewBox="0 0 560 330">
      <rect x="150" y="6" width="260" height="66" rx="16" fill="url(#dg)" />
      <text x="280" y="34" textAnchor="middle" className="fill-white text-[16px] font-semibold">
        {l("model", "模型")}
      </text>
      <text x="280" y="55" textAnchor="middle" className="fill-white/75 font-mono text-[12px]">
        {l("+ tool declarations", "+ 工具声明")}
      </text>

      {/* ask */}
      <Arrow d="M 410 42 L 470 42 L 470 150 L 410 150" />
      <text x="482" y="98" className={`${MUTED} text-[13px]`} textAnchor="start">
        {l("asks", "请求")}
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
        {l("your code runs it", "你的代码去执行")}
      </text>
      <text x="280" y="283" textAnchor="middle" className={`${MUTED} font-mono text-[12px]`}>
        {l("HTTP · SQL · filesystem · anything", "HTTP · SQL · 文件系统 · 任何东西")}
      </text>

      {/* result back */}
      <Arrow d="M 70 267 L 34 267 L 34 42 L 142 42" />
      <text x="46" y="160" className={`${MUTED} text-[13px]`}>
        {l("result", "结果")}
      </text>
    </Frame>
  );
}

/* --------------------------------------------------------- 6. the topology */

/** One host, one domain: nginx in front, a disposable app container, a database that never stops. */
export function Architecture() {
  const l = useDeckLabel();
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
        {l("app container · disposable", "应用容器 · 可随时丢弃")}
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
        {l(":5432 · trust auth, never exposed", ":5432 · trust 认证，从不对外")}
      </text>

      <rect x="708" y="130" width="292" height="136" rx="20" fill="url(#dg)" />
      <text x="854" y="180" textAnchor="middle" className="fill-white text-[17px] font-semibold">
        Postgres 18 + pgvector
      </text>
      <text x="854" y="206" textAnchor="middle" className="fill-white/80 text-[13px]">
        {l("memories · files · config · secrets", "记忆 · 文件 · 配置 · 密钥")}
      </text>
      <text x="854" y="230" textAnchor="middle" className="fill-white/70 font-mono text-[12px]">
        {l("own container · never restarts", "独立容器 · 从不重启")}
      </text>
    </Frame>
  );
}
