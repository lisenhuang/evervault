// Client-side Gemini access using the user's own API key. Every call here goes BROWSER → GOOGLE
// directly; the key never touches our backend. Text generation + TTS use the official @google/genai
// SDK; model listing uses the REST endpoint for a stable, version-independent response shape.

import { GoogleGenAI, Modality, type Content, type FunctionCall, type Part, type Schema, type Tool } from "@google/genai";

export type { Content };

/** Executes a tool the model called: receives (name, args), returns a string result for the model. */
export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>;

export const PREBUILT_VOICES = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Aoede",
  "Leda",
  "Orus",
] as const;

export type ModelInfo = { id: string; displayName: string; methods: string[] };

function client(apiKey: string) {
  return new GoogleGenAI({ apiKey });
}

/** Stream a text reply token-by-token for the given conversation. */
export async function* streamText(
  apiKey: string,
  model: string,
  contents: Content[],
  systemInstruction?: string,
): AsyncGenerator<string> {
  const ai = client(apiKey);
  const stream = await ai.models.generateContentStream({
    model,
    contents,
    ...(systemInstruction ? { config: { systemInstruction } } : {}),
  });
  for await (const chunk of stream) {
    const t = chunk.text;
    if (t) yield t;
  }
}

/**
 * Like {@link streamText} but with function calling. Streams text deltas; when the model calls a
 * tool, runs it via `executor`, feeds the result back, and continues — repeating until the model
 * answers in plain text (capped to avoid loops). `contents` is mutated to append the tool exchange.
 */
export async function* streamTextWithTools(
  apiKey: string,
  model: string,
  contents: Content[],
  systemInstruction: string,
  tools: Tool[],
  executor: ToolExecutor,
): AsyncGenerator<string> {
  const ai = client(apiKey);
  const config = { systemInstruction, tools };
  const MaxRounds = 5;

  for (let round = 0; round < MaxRounds; round++) {
    const stream = await ai.models.generateContentStream({ model, contents, config });
    // Keep the original functionCall Parts, not just the FunctionCall objects: Gemini 3.x attaches
    // a `thoughtSignature` at the Part level (sibling of functionCall) that MUST be echoed back when
    // the turn is replayed, or the next request 400s with "missing a thought_signature".
    const callParts: Part[] = [];
    for await (const chunk of stream) {
      const t = chunk.text;
      if (t) yield t;
      for (const p of chunk.candidates?.[0]?.content?.parts ?? []) {
        if (p.functionCall) callParts.push(p);
      }
    }
    if (callParts.length === 0) return; // model produced a final text answer

    const calls = callParts.map((p) => p.functionCall as FunctionCall);
    // No "tool" role in this SDK: the call is replayed (verbatim, signature intact) as a model
    // turn, the result as a user turn.
    contents.push({ role: "model", parts: callParts });
    const results = await Promise.all(calls.map((c) => executor(c.name ?? "", c.args ?? {})));
    contents.push({
      role: "user",
      parts: calls.map((c, i) => ({
        functionResponse: { id: c.id, name: c.name, response: { output: results[i] } },
      })),
    });
  }
}

/**
 * One-shot structured generation: returns the model's reply parsed as JSON, constrained to
 * `responseSchema` (build it with the `Type` enum). Used for memory extraction — not streamed.
 */
export async function generateJson<T>(
  apiKey: string,
  model: string,
  contents: Content[],
  systemInstruction: string,
  responseSchema: Schema,
): Promise<T> {
  const ai = client(apiKey);
  const res = await ai.models.generateContent({
    model,
    contents,
    config: { systemInstruction, responseMimeType: "application/json", responseSchema },
  });
  return JSON.parse(res.text ?? "{}") as T;
}

/** Synthesize speech with a TTS model. Returns base64 PCM16 + its sample rate. */
export async function synthesizeSpeech(
  apiKey: string,
  model: string,
  text: string,
  voice: string,
): Promise<{ base64: string; sampleRate: number }> {
  const ai = client(apiKey);
  const res = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  });
  const parts = res.candidates?.[0]?.content?.parts ?? [];
  const inline = parts.find((p) => p.inlineData)?.inlineData;
  if (!inline?.data) throw new Error("No audio was returned by the voice model.");
  return { base64: inline.data, sampleRate: parseRate(inline.mimeType) };
}

function parseRate(mime?: string): number {
  if (!mime) return 24000;
  const m = /rate=(\d+)/.exec(mime);
  return m ? parseInt(m[1], 10) : 24000;
}

/** List the models available to this key (REST — stable shape across SDK versions). */
export async function listModels(apiKey: string): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  let pageToken = "";
  do {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(
        res.status === 400 || res.status === 403
          ? "That Gemini API key was rejected. Double-check it at aistudio.google.com/apikey."
          : `Could not load models (HTTP ${res.status}).`,
      );
    }
    const data: { models?: RawModel[]; nextPageToken?: string } = await res.json();
    for (const m of data.models ?? []) {
      out.push({
        id: m.name.replace(/^models\//, ""),
        displayName: m.displayName ?? m.name,
        methods: m.supportedGenerationMethods ?? [],
      });
    }
    pageToken = data.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

type RawModel = { name: string; displayName?: string; supportedGenerationMethods?: string[] };

/** Models suitable for the text chat (chat-capable Gemini models, excluding TTS/embeddings/etc.). */
export function textModels(models: ModelInfo[]): ModelInfo[] {
  return models
    .filter(
      (m) =>
        m.methods.includes("generateContent") &&
        m.id.startsWith("gemini") &&
        !/(tts|embedding|image|aqa|imagen)/.test(m.id),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Voice/speech models (text-to-speech), used for the push-to-talk spoken reply. */
export function audioModels(models: ModelInfo[]): ModelInfo[] {
  return models
    .filter((m) => m.id.includes("tts") && m.methods.includes("generateContent"))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Realtime voice-call models (Live API — bidirectional streaming audio). */
export function liveModels(models: ModelInfo[]): ModelInfo[] {
  return models
    .filter((m) => m.methods.includes("bidiGenerateContent"))
    .sort((a, b) => a.id.localeCompare(b.id));
}
