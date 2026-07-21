// Narrative memory — weekly digests rolled up from per-conversation summaries.
//
// There are two memory tiers today and neither answers "how has this year gone?". The profile is 40
// one-line facts with no narrative; recall returns at most 5 disconnected paragraphs about whichever
// conversations happened to match. A digest is the missing middle: one short account of a whole week,
// so a long-horizon question gets a story instead of fragments.
//
// Stored as an ordinary ChatMemory row with Kind "digest" and a SYNTHETIC conversation id
// ("digest:2026-W29"), which is what keeps its upsert-delete confined to its own id namespace. It is
// embedded like everything else, so recall finds it with no new tool and no new dispatch arm.
//
// There is no scheduler in this product, so generation is an amortised step on the existing extraction
// path: whenever a conversation is distilled, we check whether a *completed* past week is missing its
// digest and build at most one. Cost is bounded to one extra model call per user per week.

import { searchMemories, upsertSummary, type MemoryHit } from "../recordApi";
import { embedDocument } from "./embed";
import { generateJson } from "./gemini";
import { Type, type Schema } from "@google/genai";

/** Don't bother summarising a week the user barely used — a digest of one chat is just that chat. */
const MIN_SUMMARIES_PER_WEEK = 3;
/** How far back to bother filling in. Older gaps stay unfilled; nobody is served by a 2023 digest. */
const MAX_WEEKS_BACK = 8;
/** Bound the scan and the prompt. */
const FETCH_LIMIT = 50;

/** ISO-8601 week id, e.g. "2026-W29". Weeks start Monday; the week containing Jan 4th is week 1. */
export function isoWeekId(d: Date): string {
  // Work on a UTC copy of the civil date so the arithmetic can't be shifted by the local offset.
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  // Thursday of the current week determines the year the week belongs to.
  const day = t.getUTCDay() || 7; // Monday=1 … Sunday=7
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((t.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const digestConvId = (weekId: string) => `digest:${weekId}`;

const DIGEST_SYSTEM =
  "You are writing a short private note to yourself, recording what a week was like for the person you " +
  "talk to. You are given several summaries of individual conversations from that week. Write 3-5 " +
  "sentences, in the third person, capturing the through-line: what actually mattered, what changed, " +
  "what is still unresolved. Group related threads rather than listing conversations one by one, and " +
  "prefer what recurred over what was said once.\n\n" +
  "Record ONLY what the summaries actually support. Do not speculate about motives, do not infer how " +
  "they felt unless it is stated, do not invent detail to make it read better, and do not draw " +
  "conclusions about their health, relationships or state of mind. Leave out anything sensitive that " +
  "isn't needed to make sense of the week — this note is kept for a long time, so err towards less. " +
  "If the summaries don't add up to anything worth keeping, return an empty digest string.";

const DIGEST_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: { digest: { type: Type.STRING } },
  required: ["digest"],
};

/**
 * Build at most one missing weekly digest. Fire-and-forget from the extraction path; never awaited by
 * the chat. Returns the week id it wrote, or null when there was nothing to do.
 */
export async function maybeRollupDigests(model: string, now = new Date()): Promise<string | null> {
  try {
    // Everything we might roll up, and everything already rolled up. Both are newest-first with no
    // query, which is the cheap "recent rows of this kind" path on the search endpoint.
    const [summaries, digests] = await Promise.all([
      searchMemories(null, "", FETCH_LIMIT, { kind: "summary" }),
      searchMemories(null, "", FETCH_LIMIT, { kind: "digest" }),
    ]);
    if (summaries.length === 0) return null;

    const done = new Set(
      digests.map((d) => (d.conversationId ?? "").replace(/^digest:/, "")).filter(Boolean),
    );
    const thisWeek = isoWeekId(now);

    // Group the summaries by the week they were recorded in.
    const byWeek = new Map<string, MemoryHit[]>();
    for (const s of summaries) {
      const when = new Date(s.createdAt);
      if (!Number.isFinite(when.getTime())) continue;
      const wk = isoWeekId(when);
      if (wk === thisWeek) continue; // the current week isn't over — digesting it would be premature
      if (done.has(wk)) continue;
      const list = byWeek.get(wk) ?? [];
      list.push(s);
      byWeek.set(wk, list);
    }
    if (byWeek.size === 0) return null;

    // Oldest missing week first, so a gap fills in chronologically over successive extractions.
    const cutoff = new Date(now.getTime() - MAX_WEEKS_BACK * 7 * 86_400_000);
    const oldestAllowed = isoWeekId(cutoff);
    const candidate = [...byWeek.entries()]
      .filter(([wk, items]) => wk >= oldestAllowed && items.length >= MIN_SUMMARIES_PER_WEEK)
      .sort(([a], [b]) => (a < b ? -1 : 1))[0];
    if (!candidate) return null;

    const [weekId, items] = candidate;
    const body = items
      .slice()
      .reverse() // chronological reads better than newest-first
      .map((s) => `- ${s.content}`)
      .join("\n");

    const result = await generateJson<{ digest?: string }>(
      model,
      [{ role: "user" as const, parts: [{ text: `Conversation summaries from ${weekId}:\n\n${body}` }] }],
      DIGEST_SYSTEM,
      DIGEST_SCHEMA,
    );
    const text = (result?.digest ?? "").trim();
    if (!text) return null;

    const embedding = (await embedDocument(text)) ?? undefined;
    upsertSummary(digestConvId(weekId), text, embedding, "digest");
    return weekId;
  } catch {
    return null; // never let a digest failure disturb the chat
  }
}
