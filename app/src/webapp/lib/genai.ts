// Minimal Gemini wire-format types + the Type enum, so the app can build `contents`, `tools`, and
// `responseSchema` exactly as the @google/genai SDK would — but send them to OUR backend proxy (which
// forwards them to Google with a system key) instead of calling Google directly. No SDK, no API key.

export type InlineData = { mimeType: string; data: string };

export type FunctionCall = { id?: string; name?: string; args?: Record<string, unknown> };

export type Part = {
  text?: string;
  inlineData?: InlineData;
  functionCall?: FunctionCall;
  functionResponse?: { id?: string; name?: string; response: Record<string, unknown> };
  // Gemini 3.x attaches a Part-level thoughtSignature next to functionCall that MUST be echoed back
  // verbatim when the turn is replayed — we keep whole Parts, so it rides along automatically.
  thoughtSignature?: string;
};

export type Content = { role: "user" | "model"; parts: Part[] };

/** JSON-Schema type tokens as Gemini's REST API expects them (uppercase). */
export const Type = {
  STRING: "STRING",
  NUMBER: "NUMBER",
  INTEGER: "INTEGER",
  BOOLEAN: "BOOLEAN",
  ARRAY: "ARRAY",
  OBJECT: "OBJECT",
} as const;

export type Schema = {
  type: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  required?: string[];
};

export type FunctionDeclaration = { name: string; description: string; parameters: Schema };

/** A tools entry for the request body. */
export type Tool = { functionDeclarations: FunctionDeclaration[] };
