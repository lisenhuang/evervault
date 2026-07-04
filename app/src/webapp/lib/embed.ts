// Embedding for memory — computed SERVER-SIDE via the proxy (/chat/ai/embed) with the system keys and
// the admin-locked model + dimension, so stored vectors and query vectors share one space. Returns null
// when there's no policy or on error — recording still stores the raw text.

import { apiJson } from "@/lib/api";

export type EmbeddingPolicy = { enabled: boolean; model: string | null; dimensions: number };

let policyCache: EmbeddingPolicy | null = null;

export async function getEmbeddingPolicy(): Promise<EmbeddingPolicy> {
  if (policyCache) return policyCache;
  try {
    policyCache = await apiJson<EmbeddingPolicy>("/chat/memories/config");
  } catch {
    /* ignore */
  }
  return policyCache ?? { enabled: false, model: null, dimensions: 1536 };
}

async function embed(text: string): Promise<number[] | null> {
  const policy = await getEmbeddingPolicy();
  if (!policy.enabled || !policy.model) return null;
  const clipped = text.trim().slice(0, 8000);
  if (!clipped) return null;
  try {
    const { vector } = await apiJson<{ vector: number[] }>("/chat/ai/embed", {
      method: "POST",
      body: JSON.stringify({ model: policy.model, text: clipped, dimensions: policy.dimensions }),
    });
    return vector && vector.length ? vector : null;
  } catch {
    return null;
  }
}

// The proxy embeds document and query text the same way (one locked model + dimension).
export const embedDocument = (text: string) => embed(text);
export const embedQuery = (text: string) => embed(text);
