// Server-side text chat for the /webapp, used when the admin's primary text model isn't Gemini
// (e.g. ChatGPT, which rides the admin's connected account — those credentials can never reach a
// browser). The whole transcript goes to POST /api/chat/ai/text in a neutral provider-agnostic
// shape; the backend runs the primary model and falls back to the configured fallback when it's
// unavailable, streaming NDJSON frames back. Tools still execute in the browser: a `toolCalls`
// frame ends the request, we run the tools, append the results, and re-POST — the same rounds
// contract as streamTextWithTools, so Chat.tsx can use either interchangeably.

import type { Content, FunctionDeclaration, Schema, Tool } from "@google/genai";
import type { ToolExecutor } from "./gemini";

/** Mirror of the backend's neutral AiChatMessage (camelCase on the wire). */
export type NeutralMessage = {
  role: "user" | "assistant" | "tool";
  content?: string | null;
  toolCalls?: WireToolCall[] | null;
  /** On tool-result turns: the id of the call this result answers. */
  toolCallId?: string | null;
  /** On tool-result turns: the tool's name. */
  name?: string | null;
  /** Opaque provider state (e.g. ChatGPT reasoning items) echoed verbatim on the next round. */
  providerState?: string | null;
};

type WireToolCall = { id: string; name: string; argumentsJson: string; thoughtSignature?: string | null };

type Frame = {
  type: "delta" | "toolCalls" | "done" | "error";
  text?: string | null;
  calls?: WireToolCall[] | null;
  providerState?: string | null;
  error?: string;
  referenceCode?: string;
};

/**
 * True when every part of every content is plain text — the only shape the server text endpoint
 * accepts. Conversations carrying inline media (images / PDFs / voice clips) stay on the direct
 * Gemini path, which understands those natively.
 */
export function contentsAreTextOnly(contents: Content[]): boolean {
  return contents.every((c) => (c.parts ?? []).every((p) => typeof (p as { text?: unknown }).text === "string"));
}

/** Gemini-shaped contents (text parts only — check {@link contentsAreTextOnly} first) → neutral messages. */
export function toNeutralMessages(contents: Content[]): NeutralMessage[] {
  return contents.map((c) => ({
    role: c.role === "model" ? ("assistant" as const) : ("user" as const),
    content: (c.parts ?? [])
      .map((p) => (p as { text?: string }).text ?? "")
      .filter(Boolean)
      .join("\n\n"),
  }));
}

// Gemini FunctionDeclaration parameters use the SDK's Type enum ("OBJECT", "STRING", …) while the
// server expects plain JSON Schema — lowercase the types and keep the structural fields.
function toJsonSchema(s: Schema | undefined): Record<string, unknown> {
  if (!s) return { type: "object", properties: {} };
  const out: Record<string, unknown> = {};
  if (s.type) out.type = String(s.type).toLowerCase();
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.properties) {
    out.properties = Object.fromEntries(
      Object.entries(s.properties).map(([k, v]) => [k, toJsonSchema(v as Schema)]),
    );
  }
  if (s.required?.length) out.required = s.required;
  if (s.items) out.items = toJsonSchema(s.items as Schema);
  return out;
}

function toServerTools(tools: Tool[]) {
  const decls: FunctionDeclaration[] = tools.flatMap((t) => t.functionDeclarations ?? []);
  return decls.map((d) => ({
    name: d.name ?? "",
    description: d.description ?? "",
    parametersJson: JSON.stringify(toJsonSchema(d.parameters)),
  }));
}

function parseArgs(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Yield one parsed NDJSON frame per line; tolerates frames split across network chunks. */
async function* readFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<Frame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line) as Frame;
      } catch {
        /* skip a malformed line — the terminal frame still decides the outcome */
      }
    }
    if (done) break;
  }
  const tail = (buf + decoder.decode()).trim();
  if (tail) {
    try {
      yield JSON.parse(tail) as Frame;
    } catch {
      /* ignore */
    }
  }
}

const MAX_ROUNDS = 5; // same tool-loop cap as streamTextWithTools

/**
 * Drop-in counterpart of streamTextWithTools that runs the turn server-side. Streams text deltas;
 * when the model calls tools, executes them via `executor`, appends the exchange to `messages`,
 * and re-POSTs — until the model answers in plain text (capped). Mutates `messages`.
 * Failures throw an Error whose message is the backend's {error, referenceCode} JSON, which
 * friendlyAiError already knows how to read.
 */
export async function* streamServerChatWithTools(
  messages: NeutralMessage[],
  system: string,
  tools: Tool[],
  executor: ToolExecutor,
): AsyncGenerator<string> {
  const serverTools = toServerTools(tools);

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await fetch("/api/chat/ai/text", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, system, tools: serverTools }),
    });
    if (!res.ok || !res.body) {
      // The pre-stream failure body is {error, referenceCode} JSON — pass it through verbatim, with
      // the HTTP status attached so friendlyAiError classifies it (busy vs unreachable vs generic).
      const err = new Error(await res.text().catch(() => `HTTP ${res.status}`)) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }

    let acc = ""; // deltas received this round
    let roundText: string | null = null; // authoritative text from the terminal frame
    let calls: WireToolCall[] = [];
    let providerState: string | null = null;

    for await (const frame of readFrames(res.body)) {
      if (frame.type === "delta" && frame.text) {
        acc += frame.text;
        yield frame.text;
      } else if (frame.type === "toolCalls") {
        roundText = frame.text ?? null;
        calls = frame.calls ?? [];
        providerState = frame.providerState ?? null;
      } else if (frame.type === "done") {
        roundText = frame.text ?? null;
      } else if (frame.type === "error") {
        throw new Error(JSON.stringify({ error: frame.error, referenceCode: frame.referenceCode }));
      }
    }

    // The terminal frame's text is authoritative — yield whatever the deltas didn't already cover
    // (the whole reply for non-streaming fallback legs, normally nothing for streamed ones).
    if (roundText && roundText.length > acc.length) yield roundText.slice(acc.length);

    if (calls.length === 0) return; // final text answer

    messages.push({ role: "assistant", content: roundText ?? (acc || null), toolCalls: calls, providerState });
    const results = await Promise.all(calls.map((c) => executor(c.name, parseArgs(c.argumentsJson))));
    messages.push(
      ...calls.map((c, i) => ({
        role: "tool" as const,
        toolCallId: c.id,
        name: c.name,
        content: results[i],
      })),
    );
  }
}
