// Shared types for the admin AI features. Field names match the backend DTOs (camelCase).

export type Provider = "gemini" | "openrouter";

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
export type KeyCheckResult = { id: number; keyHint: string; ok: boolean; message: string };
export type CheckKeysResult = { results: KeyCheckResult[] };

export type ModelInfo = {
  id: string;
  name: string;
  provider: string;
  isFree: boolean;
  promptPricePerMTok: number | null;
  completionPricePerMTok: number | null;
  priceLabel: string | null;
};

export type ModelsResult = { provider: string; models: ModelInfo[]; warning: string | null };

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
};

export type ChatConfigDto = {
  selectedProvider: string | null;
  geminiModel: string | null;
  openRouterModel: string | null;
};

export type ToolCall = { id: string; name: string; argumentsJson: string };

export type ChatMessage = {
  role: string; // "system" | "user" | "assistant" | "tool"
  content?: string | null;
  toolCalls?: ToolCall[] | null;
  toolCallId?: string | null;
  name?: string | null;
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
