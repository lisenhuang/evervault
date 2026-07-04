// AI access for the app — the mobile equivalent of the web's lib/gemini.ts, but every call goes to OUR
// backend proxy (/chat/ai/*), which runs it against the system Gemini keys with failover. The app never
// holds a key. Streaming chat uses SSE (expo/fetch); everything else is plain JSON.

import { fetch as expoFetch } from "expo/fetch";

import { API_BASE } from "@/config";
import { apiJson } from "@/lib/api";
import { getToken } from "@/lib/session";
import type { Content, Part, Schema, Tool } from "./genai";

export type { Content, Part } from "./genai";

/** Executes a tool the model called: (name, args) → string result for the model. */
export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>;

export type ModelInfo = { id: string; displayName: string; methods: string[] };

// --- Streaming SSE (text chat) ---

async function openStream(body: unknown): Promise<Response> {
  const token = await getToken();
  const res = await expoFetch(`${API_BASE}/chat/ai/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Chat request failed (HTTP ${res.status}).`);
  return res as unknown as Response;
}

type SseEvent = { chunk?: GenChunk; error?: string };
type GenChunk = { candidates?: { content?: { parts?: Part[] } }[] };

/** Parse a Gemini `alt=sse` stream at the BYTE level: events are split on the ASCII "\n\n" (0x0A 0x0A),
 * then each complete event's bytes are UTF-8 decoded — so multibyte characters (e.g. Chinese) that span
 * chunk reads are never corrupted. Recognizes our `event: error` frames too. */
async function* parseSse(res: Response): AsyncGenerator<SseEvent> {
  const reader = (res.body as unknown as ReadableStream<Uint8Array>).getReader();
  let buf: Uint8Array = new Uint8Array(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) buf = concat(buf, value);
      let start = 0;
      for (;;) {
        const idx = indexOfDoubleNewline(buf, start);
        if (idx < 0) break;
        const eventBytes = buf.subarray(start, idx);
        start = idx + 2;
        const evt = decodeEvent(utf8ToString(eventBytes));
        if (evt) yield evt;
      }
      if (start > 0) buf = buf.subarray(start);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function decodeEvent(raw: string): SseEvent | null {
  let data = "";
  let event = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("data:")) data += line.slice(5).trimStart();
    else if (line.startsWith("event:")) event = line.slice(6).trim();
  }
  if (!data || data === "[DONE]") return null;
  if (event === "error") {
    try {
      return { error: JSON.parse(data).error ?? "The reply failed." };
    } catch {
      return { error: data };
    }
  }
  try {
    return { chunk: JSON.parse(data) as GenChunk };
  } catch {
    return null; // partial/unknown frame
  }
}

/** Stream a text reply token-by-token. */
export async function* streamText(
  model: string,
  contents: Content[],
  systemInstruction?: string,
): AsyncGenerator<string> {
  const res = await openStream({ model, contents, systemInstruction });
  for await (const ev of parseSse(res)) {
    if (ev.error) throw new Error(ev.error);
    for (const p of ev.chunk?.candidates?.[0]?.content?.parts ?? []) if (p.text) yield p.text;
  }
}

/**
 * Streaming text with function calling. Streams text deltas; when the model calls a tool, runs it via
 * `executor`, appends the exchange to `contents` (keeping whole call Parts so Gemini 3.x thoughtSignatures
 * ride along), and continues — capped to avoid loops. Mirrors the web's streamTextWithTools.
 */
export async function* streamTextWithTools(
  model: string,
  contents: Content[],
  systemInstruction: string,
  tools: Tool[],
  executor: ToolExecutor,
): AsyncGenerator<string> {
  const MaxRounds = 5;
  for (let round = 0; round < MaxRounds; round++) {
    const res = await openStream({ model, contents, systemInstruction, tools });
    const callParts: Part[] = [];
    for await (const ev of parseSse(res)) {
      if (ev.error) throw new Error(ev.error);
      for (const p of ev.chunk?.candidates?.[0]?.content?.parts ?? []) {
        if (p.text) yield p.text;
        if (p.functionCall) callParts.push(p);
      }
    }
    if (callParts.length === 0) return;

    const calls = callParts.map((p) => p.functionCall!);
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

// --- One-shot JSON calls (all via the JSON proxy endpoints) ---

/** Structured generation constrained to `responseSchema`. Used for memory/profile extraction. */
export async function generateJson<T>(
  model: string,
  contents: Content[],
  systemInstruction: string,
  responseSchema: Schema,
): Promise<T> {
  const { text } = await apiJson<{ text: string }>("/chat/ai/generate-json", {
    method: "POST",
    body: JSON.stringify({ model, contents, systemInstruction, responseSchema }),
  });
  try {
    return JSON.parse(text || "{}") as T;
  } catch {
    return {} as T;
  }
}

/** Transcribe a spoken clip verbatim (empty string when there's no intelligible speech). */
export async function transcribeAudio(model: string, audioBase64: string, mimeType: string): Promise<string> {
  const { text } = await apiJson<{ text: string }>("/chat/ai/transcribe", {
    method: "POST",
    body: JSON.stringify({ model, audioBase64, mimeType }),
  });
  return (text ?? "").trim();
}

/** Compact factual description of an attached image, for the searchable memory archive. */
export async function describeImage(model: string, imageBase64: string, mimeType: string): Promise<string> {
  const { text } = await apiJson<{ text: string }>("/chat/ai/describe-image", {
    method: "POST",
    body: JSON.stringify({ model, imageBase64, mimeType }),
  });
  return (text ?? "").trim();
}

/** Synthesize speech. Returns base64 PCM16 + its sample rate. */
export async function synthesizeSpeech(
  model: string,
  text: string,
  voice: string,
): Promise<{ base64: string; sampleRate: number }> {
  const res = await apiJson<{ base64: string; sampleRate: number }>("/chat/ai/tts", {
    method: "POST",
    body: JSON.stringify({ model, text, voice }),
  });
  if (!res.base64) throw new Error("No audio was returned by the voice model.");
  return res;
}

/** List models available to the system keys. */
export async function listModels(): Promise<ModelInfo[]> {
  const res = await apiJson<{ models: ModelInfo[]; warning: string | null }>("/chat/ai/models");
  if ((!res.models || res.models.length === 0) && res.warning) throw new Error(res.warning);
  return res.models ?? [];
}

// --- Model bucketing (identical rules to the web) ---

export function textModels(models: ModelInfo[]): ModelInfo[] {
  return models
    .filter(
      (m) => m.methods.includes("generateContent") && m.id.startsWith("gemini") && !/(tts|embedding|image|aqa|imagen)/.test(m.id),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function audioModels(models: ModelInfo[]): ModelInfo[] {
  return models.filter((m) => m.id.includes("tts") && m.methods.includes("generateContent")).sort((a, b) => a.id.localeCompare(b.id));
}

export function liveModels(models: ModelInfo[]): ModelInfo[] {
  return models.filter((m) => m.methods.includes("bidiGenerateContent")).sort((a, b) => a.id.localeCompare(b.id));
}

// --- byte helpers (no dependency on TextDecoder, which isn't guaranteed on Hermes) ---

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function indexOfDoubleNewline(buf: Uint8Array, from: number): number {
  for (let i = from; i + 1 < buf.length; i++) if (buf[i] === 0x0a && buf[i + 1] === 0x0a) return i;
  return -1;
}

/** Decode a COMPLETE UTF-8 byte slice to a string (events never split a multibyte sequence). */
function utf8ToString(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    let cp: number;
    if (b < 0x80) cp = b;
    else if (b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
    else if (b < 0xf0) cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    else {
      cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    }
    if (cp > 0xffff) {
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      out += String.fromCharCode(cp);
    }
  }
  return out;
}

/**
 * Gemini's 30 prebuilt TTS/Live voices. `name` is sent to the API; `mood`/`gender` are shown to help
 * the user choose. Same list as the web.
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
