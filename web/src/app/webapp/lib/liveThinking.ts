// Which Gemini Live models can be told how hard to think, and how deep the admin set them.
//
// Deliberately free of any @google/genai runtime import so the admin page can use the predicate and
// the level list without pulling the Live/SDK graph into its bundle. The piece that actually builds a
// thinkingConfig (and therefore needs the SDK's ThinkingLevel enum) lives in liveShared.ts.

/**
 * How hard a Live model may think before answering, as the admin set it. "" means auto: send no
 * thinkingConfig at all and let the model use its own default, which on Gemini 3.x Live is MINIMAL.
 */
export type LiveReasoning = "" | "minimal" | "low" | "medium" | "high";

/** The pickable levels, shallowest first. "" (auto) is not a member — it's the absence of a level. */
export const LIVE_REASONING_LEVELS = ["minimal", "low", "medium", "high"] as const;

/** Anything that isn't a known level collapses to "" (auto). */
export function normalizeLiveReasoning(value: string | null | undefined): LiveReasoning {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" ? value : "";
}

/**
 * Whether this Live model accepts a thinkingConfig at all.
 *
 * This gate is not cosmetic. The Live API rejects thinkingConfig on a model that doesn't support
 * thinking ("An error will be returned if this field is set for models that don't support thinking"
 * — LiveConnectConfig in @google/genai), and a rejected setup kills the entire session rather than
 * just ignoring the field. The admin's Live dropdown is populated from whatever Gemini lists for
 * bidiGenerateContent, which still includes 2.0 Live and the 2.5 Live/native-audio previews — so a
 * stored level and the selected model can easily disagree, e.g. after switching models.
 *
 * Only the 3.x family is treated as supported. thinkingLevel is a 3.x-era Live feature (2.5 Live took
 * thinkingBudget on the REST path and has documented thinkingConfig failures over Live), and the cost
 * of guessing wrong is asymmetric: a false negative just means the model uses its own default, which
 * is exactly today's behavior, while a false positive breaks every call on that model. So anything we
 * don't positively recognize — older families, and any Live model Google ships next — gets nothing.
 * From 3.8 on, the exception is a model named "extended thinking", which exists to be given a level.
 *
 * Mirrors the family test the REST path already uses (GeminiProvider.ThinkingConfig, backend).
 */
export function liveSupportsThinking(model: string): boolean {
  // The 3.8 generation split thinking out into its own model: 3.8 Live Extended Thinking takes a level,
  // while plain 3.8 Live rejects any thinkingConfig at setup. So below 3.8 the whole 3.x family
  // qualifies, and from 3.8 on only a model that says so in its name does.
  const v = liveModelVersion(model);
  if (v === null) return false;
  if (v.major === 3 && v.minor < 8) return true;
  return isExtendedThinking(model) && atLeast38(v);
}

/**
 * Whether this Live model's setup accepts the MINIMAL level. Extended Thinking takes low/medium/high
 * only and rejects MINIMAL, which would fail the whole session — so there "minimal" is sent as no
 * level at all, which still leaves the model on its fastest default.
 */
export function liveAcceptsMinimalThinking(model: string): boolean {
  return !isExtendedThinking(model);
}

/**
 * Whether this Live model may keep working after it says turnComplete: running tool calls in the
 * background and speaking again once they return. Gemini 3.8 Live made that the default (asynchronous,
 * NON_BLOCKING function calls), and on 3.8 Live Extended Thinking it is the only mode. On these models a
 * "let me check that" is its own complete turn, and the answer follows as a later one.
 *
 * Unlike the thinking gate, the unknown case is assumed to be TRUE. The costs run the other way here:
 * treating a synchronous model as asynchronous only waits for turnComplete instead of finishing a
 * moment earlier on generationComplete, while the reverse cuts every tool-backed answer down to the
 * filler before it. Only a model we can date to before 3.8 is treated as synchronous.
 */
export function liveAnswersAsync(model: string): boolean {
  const v = liveModelVersion(model);
  return v === null || atLeast38(v);
}

function atLeast38(v: { major: number; minor: number }): boolean {
  return v.major > 3 || (v.major === 3 && v.minor >= 8);
}

/** Loose on purpose ("…-extended-thinking", "…-thinking-preview"): either word marks the model that
 *  exists to be given a thinking level. */
function isExtendedThinking(model: string): boolean {
  return /extended|thinking/i.test(model);
}

/** "gemini-3.8-live" → {3, 8}; "gemini-2.0-flash-live-001" → {2, 0}; anything else → null. */
function liveModelVersion(model: string): { major: number; minor: number } | null {
  const m = /gemini-(\d+)(?:\.(\d+))?/i.exec(model);
  return m ? { major: Number(m[1]), minor: Number(m[2] ?? 0) } : null;
}
