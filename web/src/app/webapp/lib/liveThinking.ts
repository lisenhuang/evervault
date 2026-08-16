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
 *
 * Mirrors the family test the REST path already uses (GeminiProvider.ThinkingConfig, backend).
 */
export function liveSupportsThinking(model: string): boolean {
  return /gemini-3/i.test(model);
}
