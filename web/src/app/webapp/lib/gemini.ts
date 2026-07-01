// Client-side Gemini access using the user's own API key. Every call here goes BROWSER → GOOGLE
// directly; the key never touches our backend. Text generation + TTS use the official @google/genai
// SDK; model listing uses the REST endpoint for a stable, version-independent response shape.

import { GoogleGenAI, Modality, type Content, type FunctionCall, type Part, type Schema, type Tool } from "@google/genai";

export type { Content };

/** Executes a tool the model called: receives (name, args), returns a string result for the model. */
export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>;

/**
 * Gemini's 30 prebuilt TTS/Live voices. `name` is the value sent to the API;
 * `mood` is the characteristic documented at
 * https://ai.google.dev/gemini-api/docs/speech-generation#voices.
 * `gender` is a community classification (Google's table doesn't list it) shown
 * only to help users choose.
 */
export const PREBUILT_VOICES = [
  { name: "Zephyr", mood: "Bright", gender: "Female" },
  { name: "Puck", mood: "Upbeat", gender: "Male" },
  { name: "Charon", mood: "Informative", gender: "Male" },
  { name: "Kore", mood: "Firm", gender: "Female" },
  { name: "Fenrir", mood: "Excitable", gender: "Male" },
  { name: "Leda", mood: "Youthful", gender: "Female" },
  { name: "Orus", mood: "Firm", gender: "Male" },
  { name: "Aoede", mood: "Breezy", gender: "Female" },
  { name: "Callirrhoe", mood: "Easy-going", gender: "Female" },
  { name: "Autonoe", mood: "Bright", gender: "Female" },
  { name: "Enceladus", mood: "Breathy", gender: "Male" },
  { name: "Iapetus", mood: "Clear", gender: "Male" },
  { name: "Umbriel", mood: "Easy-going", gender: "Male" },
  { name: "Algieba", mood: "Smooth", gender: "Male" },
  { name: "Despina", mood: "Smooth", gender: "Female" },
  { name: "Erinome", mood: "Clear", gender: "Female" },
  { name: "Algenib", mood: "Gravelly", gender: "Male" },
  { name: "Rasalgethi", mood: "Informative", gender: "Male" },
  { name: "Laomedeia", mood: "Upbeat", gender: "Female" },
  { name: "Achernar", mood: "Soft", gender: "Female" },
  { name: "Alnilam", mood: "Firm", gender: "Male" },
  { name: "Schedar", mood: "Even", gender: "Male" },
  { name: "Gacrux", mood: "Mature", gender: "Female" },
  { name: "Pulcherrima", mood: "Forward", gender: "Female" },
  { name: "Achird", mood: "Friendly", gender: "Male" },
  { name: "Zubenelgenubi", mood: "Casual", gender: "Male" },
  { name: "Vindemiatrix", mood: "Gentle", gender: "Female" },
  { name: "Sadachbia", mood: "Lively", gender: "Male" },
  { name: "Sadaltager", mood: "Knowledgeable", gender: "Male" },
  { name: "Sulafat", mood: "Warm", gender: "Female" },
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

/**
 * Transcribe a spoken clip to text — one-shot, non-streamed. Returns the verbatim words, or "" when
 * there's no intelligible speech. Uses the chat text model (audio-capable — it already answers the
 * spoken reply from the same inline audio). Best-effort: callers treat "" as "no transcript".
 */
export async function transcribeAudio(
  apiKey: string,
  model: string,
  audioBase64: string,
  mimeType: string,
): Promise<string> {
  const ai = client(apiKey);
  const res = await ai.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType, data: audioBase64 } },
          {
            text:
              "Transcribe this audio verbatim. Return ONLY the spoken words, with no commentary, " +
              "quotes, or labels. If there is no intelligible speech, return an empty string.",
          },
        ],
      },
    ],
  });
  return (res.text ?? "").trim();
}

/**
 * Recognize an attached image — one-shot, non-streamed. Returns a compact factual description of
 * what's in the picture (objects, people, text, setting), used to embed the image into the memory
 * vector store so it can be recalled later. Best-effort: callers treat "" as "no description".
 */
export async function describeImage(
  apiKey: string,
  model: string,
  imageBase64: string,
  mimeType: string,
): Promise<string> {
  const ai = client(apiKey);
  const res = await ai.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType, data: imageBase64 } },
          {
            text:
              "Describe this image in 2-4 factual sentences for a searchable archive: the main " +
              "subjects, any visible text, and the setting. Return ONLY the description, with no " +
              "preamble or commentary.",
          },
        ],
      },
    ],
  });
  return (res.text ?? "").trim();
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
