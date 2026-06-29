// Client-side embedding for memory. Runs in the browser with the USER'S OWN Gemini key (never ours),
// using the admin-locked model + dimension (fetched once) so stored vectors and query vectors share one
// space. Returns null when there's no key, no policy, or on error — recording still stores the raw text.

import { GoogleGenAI } from "@google/genai";
import { api } from "../authApi";
import { store } from "./store";

export type EmbeddingPolicy = { enabled: boolean; model: string | null; dimensions: number };

let policyCache: EmbeddingPolicy | null = null;

export async function getEmbeddingPolicy(): Promise<EmbeddingPolicy> {
  if (policyCache) return policyCache;
  try {
    const res = await api("/api/chat/memories/config");
    if (res.ok) policyCache = (await res.json()) as EmbeddingPolicy;
  } catch {
    /* ignore */
  }
  return policyCache ?? { enabled: false, model: null, dimensions: 1536 };
}

function l2normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  return norm ? v.map((x) => x / norm) : v;
}

async function embed(text: string, taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY"): Promise<number[] | null> {
  const key = store.getKey();
  if (!key) return null;
  const policy = await getEmbeddingPolicy();
  if (!policy.enabled || !policy.model) return null;
  const clipped = text.trim().slice(0, 8000);
  if (!clipped) return null;
  try {
    const ai = new GoogleGenAI({ apiKey: key });
    const res = await ai.models.embedContent({
      model: policy.model,
      contents: clipped,
      config: { taskType, outputDimensionality: policy.dimensions },
    });
    const values = res.embeddings?.[0]?.values;
    if (!values || values.length === 0) return null;
    // gemini-embedding-001 is not normalized below 3072 dims — normalize for cosine search.
    return l2normalize(values);
  } catch {
    return null;
  }
}

export const embedDocument = (text: string) => embed(text, "RETRIEVAL_DOCUMENT");
export const embedQuery = (text: string) => embed(text, "RETRIEVAL_QUERY");
