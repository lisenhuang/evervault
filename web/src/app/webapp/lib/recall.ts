// Retrieval-augmented recall for the chat. Turns the conversation into a good search query, fetches
// candidates (episodic summaries + raw turns compete), then re-ranks by similarity + recency with a
// bonus for coherent summaries, dedupes near-duplicates, and drops weak/low-signal hits. Returns a
// compact context block to prepend to the next reply. All client-side; the user's key never leaves.

import { type Content } from "@google/genai";
import { embedQuery } from "./embed";
import { formatMemoryDate } from "./time";
import { type MemoryHit, searchMemories } from "../recordApi";

type Turn = { role: "user" | "assistant"; text: string };

const SUMMARY_BONUS = 0.05; // summaries are higher-signal than raw turns → nudge them up
const RECENCY_BONUS_MAX = 0.05; // most recent memories get a small lift
const RECENCY_HALFLIFE_DAYS = 30;
const ABS_CUTOFF = 0.6; // never inject a hit whose RAW cosine distance is worse than this (≈0.4 similarity)
const REL_CUTOFF = 0.2; // …or much worse than the best hit
const JACCARD_DUP = 0.6; // skip a hit too similar to one already kept
const MAX_HITS = 5;

/** Build the embedding query from the last few turns + the new message so follow-ups/pronouns resolve. */
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

/** Adjusted distance (lower = better): start from cosine distance, reward summaries + recency. */
function score(h: MemoryHit, nowMs: number): number {
  const base = h.distance ?? 0.5; // text-fallback hits have no distance; treat as middling
  const summary = h.kind === "summary" ? SUMMARY_BONUS : 0;
  const ageDays = (nowMs - new Date(h.createdAt).getTime()) / 86_400_000;
  const recency = RECENCY_BONUS_MAX * Math.pow(0.5, Math.max(0, ageDays) / RECENCY_HALFLIFE_DAYS);
  return base - summary - recency;
}

/**
 * Retrieve relevant past context as a prefaced Content for the next reply, or null. `profileBlock` (the
 * already-injected durable profile) is passed so we don't repeat facts the model already has.
 */
export async function retrieveContext(opts: {
  recent: Turn[];
  currentText: string;
  profileBlock?: string | null;
  nowMs: number;
}): Promise<Content | null> {
  const query = buildContextualQuery(opts.recent, opts.currentText);
  if (!query) return null;

  const qv = await embedQuery(query);
  // One wide search (summaries + turns compete); text fallback when there's no vector (no key/policy).
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
    if (s > best + REL_CUTOFF) break; // ranked ascending by adjusted score → the rest are worse
    // Absolute relevance is judged on the RAW cosine distance, so the summary/recency bonuses can lift
    // ranking but never smuggle a weak match past the gate. Text-fallback hits have no distance → 0.5.
    if ((h.distance ?? 0.5) > ABS_CUTOFF) continue;
    const hw = words(h.content);
    if (keptWords.some((kw) => jaccard(hw, kw) > JACCARD_DUP)) continue; // near-duplicate of a kept hit
    if (profileWords && jaccard(hw, profileWords) > JACCARD_DUP) continue; // already in the profile block
    kept.push(h);
    keptWords.push(hw);
  }
  if (kept.length === 0) return null;

  const text =
    "Notes from your earlier conversations with this user — these are your own saved notes, not the " +
    "user's current words. Each line marks who said it. Use only if clearly relevant, don't mention " +
    'this note, and never claim the user said something unless the line is marked "You said":\n' +
    kept.map((h) => `- ${describeHit(h)}`).join("\n");
  return { role: "user", parts: [{ text }] };
}

/** Render a recalled hit with its date and speaker so the model can't misattribute it. Summaries are
 * AI-authored recaps of a past conversation; raw turns are labeled with who actually said them. */
function describeHit(h: MemoryHit): string {
  const when = formatMemoryDate(h.createdAt);
  if (h.kind === "summary") return `(${when}, my summary of an earlier conversation) ${h.content}`;
  if (h.role === "user") return `(${when}) You said: ${h.content}`;
  if (h.role === "assistant") return `(${when}) I said: ${h.content}`;
  return `(${when}) ${h.content}`;
}

/** Recent episodic summaries as a continuity block for a voice call's system instruction, or null. */
export async function buildRecentContext(k = 3): Promise<string | null> {
  const hits = await searchMemories(null, "", k, { kind: "summary" });
  if (hits.length === 0) return null;
  return (
    "Recently this user talked with you about (your own summaries of past conversations, for " +
    "continuity; don't recite, and don't attribute these to the user as their exact words):\n" +
    hits.map((h) => `- (${formatMemoryDate(h.createdAt)}) ${h.content}`).join("\n")
  );
}
