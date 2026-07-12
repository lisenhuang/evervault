// Shared types for the admin AI features. Field names match the backend DTOs (camelCase).

export type Provider = "gemini" | "openrouter" | "openai";

export type AiKeyDto = {
  id: number;
  provider: string;
  keyHint: string;
  sortOrder: number;
  enabled: boolean;
};

export type AiKeysDto = {
  gemini: AiKeyDto[];
  openRouter: AiKeyDto[];
};

// Validity is checked on demand and shown only in the page — never persisted.
// embeddingOk/embeddingMessage are set only for providers with a separate embedding capability
// (Gemini probes the gemini-embedding-002 model); null for others.
export type KeyCheckResult = {
  id: number;
  keyHint: string;
  ok: boolean;
  message: string;
  embeddingOk?: boolean | null;
  embeddingMessage?: string | null;
};
export type CheckKeysResult = { results: KeyCheckResult[] };

export type ModelInfo = {
  id: string;
  name: string;
  provider: string;
  isFree: boolean;
  promptPricePerMTok: number | null;
  completionPricePerMTok: number | null;
  priceLabel: string | null;
  // Reasoning-effort levels this model supports (ChatGPT advertises these; others are null).
  reasoningLevels: string[] | null;
  defaultReasoningLevel: string | null;
};

export type ModelsResult = { provider: string; models: ModelInfo[]; warning: string | null };

// One rolling quota window (e.g. ChatGPT's 5-hour and weekly limits). resetUnixMs is epoch ms.
export type AiRateWindow = { label: string; usedPercent: number; resetUnixMs: number | null };

export type AiKeyUsage = {
  supported: boolean;
  summary: string | null;
  usage: number | null;
  limit: number | null;
  remaining: number | null;
  isFreeTier: boolean | null;
  rateLimit: string | null;
  resetNote: string | null;
  dailyLimit: number | null;
  dailyRemaining: number | null;
  dailyUsed: number | null;
  resetUnixMs: number | null;
  windows: AiRateWindow[] | null;
};

export type ChatConfigDto = {
  selectedProvider: string | null;
  geminiModel: string | null;
  openRouterModel: string | null;
  openAiModel: string | null;
  reasoningEffort: string | null; // "auto" | "off" | "low" | "medium" | "high" | null (Gemini/OpenRouter)
  openAiReasoning: string | null; // ChatGPT's own level (minimal/low/medium/high/xhigh/…), or "auto"
};

// "Sign in with ChatGPT" (Codex OAuth) connection status. No secrets.
export type OpenAiStatus = {
  connected: boolean;
  email: string | null;
  connectedAt: string | null;
  expiresAt: string | null;
};

export type EmbeddingConfigDto = {
  provider: string;
  model: string | null;
  dimensions: number;
  locked: boolean;
  lockedAt: string | null;
};

export type ToolCall = { id: string; name: string; argumentsJson: string };

export type ChatMessage = {
  role: string; // "system" | "user" | "assistant" | "tool"
  content?: string | null;
  toolCalls?: ToolCall[] | null;
  toolCallId?: string | null;
  name?: string | null;
  // Opaque provider-only state (OpenAI reasoning items) round-tripped verbatim through the transcript.
  providerState?: string | null;
};

export type ProposedAction = {
  toolCallId: string;
  toolName: string;
  argumentsJson: string;
  humanSummary: string;
  dangerous: boolean;
  signature: string;
};

export type ChatTurnResponse = {
  status: "message" | "proposal" | "error";
  assistantText?: string | null;
  proposal?: ProposedAction | null;
  error?: string | null;
  messages: ChatMessage[];
};
