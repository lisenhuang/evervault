// Keyless Gemini access for the /webapp. Every call routes through our backend reverse-proxy
// (/api/chat/ai/gemini/*), which injects a pooled Gemini key server-side with failover — the browser
// never holds a key. Uses the official @google/genai SDK pointed at the proxy via httpOptions.baseUrl.

import { GoogleGenAI, Modality, type Content, type FunctionCall, type Part, type Schema, type Tool } from "@google/genai";
import { fixSpokenBrandName, TRANSCRIPTION_VOCABULARY_HINT } from "./brandName";

export type { Content, Tool };

/** Executes a tool the model called: receives (name, args), returns a string result for the model. */
export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>;

// The 30 prebuilt voice list + metadata now lives in the dependency-light ./voices module (so the
// admin can reuse it without pulling this Gemini SDK bundle). Re-exported here for existing importers.
export { PREBUILT_VOICES } from "./voices";

export type ModelInfo = { id: string; displayName: string; methods: string[] };

/**
 * A keyless Gemini client: routes every REST call through our backend reverse-proxy, which injects a
 * pooled key server-side (with failover). `apiKey` is a placeholder the proxy strips; `baseUrl` is
 * same-origin, so the SDK's fetch carries the ev_user session cookie automatically. Exported for the
 * embedding path (embed.ts), which builds its own request off the same client.
 */
export function client() {
  return new GoogleGenAI({
    apiKey: "webapp",
    httpOptions: { baseUrl: `${location.origin}/api/chat/ai/gemini` },
  });
}

/** Stream a text reply token-by-token for the given conversation. */
export async function* streamText(
  model: string,
  contents: Content[],
  systemInstruction?: string,
): AsyncGenerator<string> {
  const ai = client();
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
  model: string,
  contents: Content[],
  systemInstruction: string,
  tools: Tool[],
  executor: ToolExecutor,
): AsyncGenerator<string> {
  const ai = client();
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
  model: string,
  contents: Content[],
  systemInstruction: string,
  responseSchema: Schema,
): Promise<T> {
  const ai = client();
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
 *
 * The prompt carries the app's own vocabulary (see brandName.ts): "EverVault" is not a word any
 * recognizer knows, so unprompted it comes back as "everybody" / "ever vault" — and it is the word
 * users say most often, since it's how they address the assistant. The result is repaired as well,
 * for the times naming it in the prompt isn't enough.
 */
export async function transcribeAudio(
  model: string,
  audioBase64: string,
  mimeType: string,
): Promise<string> {
  const ai = client();
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
              "quotes, or labels. If there is no intelligible speech, return an empty string.\n\n" +
              TRANSCRIPTION_VOCABULARY_HINT,
          },
        ],
      },
    ],
  });
  return fixSpokenBrandName((res.text ?? "").trim());
}

/**
 * Recognize an attached image — one-shot, non-streamed. Returns a compact factual description of
 * what's in the picture (objects, people, text, setting), used to embed the image into the memory
 * vector store so it can be recalled later. Best-effort: callers treat "" as "no description".
 */
export async function describeImage(
  model: string,
  imageBase64: string,
  mimeType: string,
): Promise<string> {
  const ai = client();
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

/**
 * Summarize an attached PDF — one-shot, non-streamed. Returns a compact factual summary of the
 * document (topic, key points, any names/dates), used to embed the file into the memory vector
 * store so it can be recalled later. Best-effort: callers treat "" as "no summary".
 */
export async function describeDocument(
  model: string,
  base64: string,
  mimeType: string,
): Promise<string> {
  const ai = client();
  const res = await ai.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType, data: base64 } },
          {
            text:
              "Summarize this document in 2-5 factual sentences for a searchable archive: its topic, " +
              "the key points, and any important names, dates, or figures. Return ONLY the summary, " +
              "with no preamble or commentary.",
          },
        ],
      },
    ],
  });
  return (res.text ?? "").trim();
}

/** Synthesize speech with a TTS model. Returns base64 PCM16 + its sample rate. */
export async function synthesizeSpeech(
  model: string,
  text: string,
  voice: string,
): Promise<{ base64: string; sampleRate: number }> {
  const ai = client();
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
