// Retrieval-augmented recall for the chat. Turns the conversation into a search query, fetches
// candidates (episodic summaries + raw turns compete), re-ranks by similarity + recency with a bonus for
// coherent summaries, dedupes near-duplicates, and returns a compact context block to prepend.

import type { Content } from "./genai";
import { embedQuery } from "./embed";
import { type MemoryHit, searchMemories } from "./recordApi";
import { formatMemoryDate } from "./time";

type Turn = { role: "user" | "assistant"; text: string };

const SUMMARY_BONUS = 0.05;
const RECENCY_BONUS_MAX = 0.05;
const RECENCY_HALFLIFE_DAYS = 30;
const ABS_CUTOFF = 0.7;
const REL_CUTOFF = 0.25;
const JACCARD_DUP = 0.6;
const MAX_HITS = 5;

export function buildContextualQuery(recent: Turn[], currentText: string): string {
  const tail = recent
    .filter((t) => t.text.trim())
    .slice(-3)
    .map((t) => t.text.trim());
  return [...tail, currentText.trim()].filter(Boolean).join("\n").slice(0, 2000);
}

function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

function score(h: MemoryHit, nowMs: number): number {
  const base = h.distance ?? 0.5;
  const summary = h.kind === "summary" ? SUMMARY_BONUS : 0;
  const ageDays = (nowMs - new Date(h.createdAt).getTime()) / 86_400_000;
  const recency = RECENCY_BONUS_MAX * Math.pow(0.5, Math.max(0, ageDays) / RECENCY_HALFLIFE_DAYS);
  return base - summary - recency;
}

export async function retrieveContext(opts: {
  recent: Turn[];
  currentText: string;
  profileBlock?: string | null;
  nowMs: number;
}): Promise<Content | null> {
  const query = buildContextualQuery(opts.recent, opts.currentText);
  if (!query) return null;

  const qv = await embedQuery(query);
  const hits = qv ? await searchMemories(qv, query, 15) : await searchMemories(null, opts.currentText, 8);
  if (hits.length === 0) return null;

  const ranked = [...hits].sort((a, b) => score(a, opts.nowMs) - score(b, opts.nowMs));
  const best = score(ranked[0], opts.nowMs);
  const profileWords = opts.profileBlock ? words(opts.profileBlock) : null;

  const kept: MemoryHit[] = [];
  const keptWords: Set<string>[] = [];
  for (const h of ranked) {
    if (kept.length >= MAX_HITS) break;
    const s = score(h, opts.nowMs);
    if (s > ABS_CUTOFF || s > best + REL_CUTOFF) break;
    const hw = words(h.content);
    if (keptWords.some((kw) => jaccard(hw, kw) > JACCARD_DUP)) continue;
    if (profileWords && jaccard(hw, profileWords) > JACCARD_DUP) continue;
    kept.push(h);
    keptWords.push(hw);
  }
  if (kept.length === 0) return null;

  const text =
    "Context — relevant things from earlier conversations with this user (use only if relevant, don't " +
    "mention this note):\n" +
    kept
      .map((h) => `- (${formatMemoryDate(h.createdAt)}${h.kind === "summary" ? ", summary" : ""}) ${h.content}`)
      .join("\n");
  return { role: "user", parts: [{ text }] };
}

/** Recent episodic summaries as a continuity block for a voice call's system instruction, or null. */
export async function buildRecentContext(k = 3): Promise<string | null> {
  const hits = await searchMemories(null, "", k, { kind: "summary" });
  if (hits.length === 0) return null;
  return (
    "Recently this user talked with you about (for continuity; don't recite):\n" +
    hits.map((h) => `- (${formatMemoryDate(h.createdAt)}) ${h.content}`).join("\n")
  );
}
