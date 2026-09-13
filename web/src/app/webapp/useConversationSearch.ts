"use client";

import { useEffect, useRef, useState } from "react";
import { searchConversations, type Conversation } from "./conversationsApi";

const PAGE_SIZE = 50;
type Result = {
  query: string;
  source: Conversation[];
  items: Conversation[];
  loading: boolean;
  error: boolean;
  hasMore: boolean;
  offset: number;
};

/** Owned once by Sidebar, shared by its desktop and mobile copies. */
export function useConversationSearch(conversations: Conversation[]) {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [retry, setRetry] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const query = input.trim();

  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    const timer = setTimeout(async () => {
      const base: Result = {
        query, source: conversations, items: [], loading: true,
        error: false, hasMore: false, offset: 0,
      };
      setResult(base);
      try {
        const items = await searchConversations(query, 0, PAGE_SIZE, controller.signal);
        if (!controller.signal.aborted) {
          setResult({ ...base, items, loading: false, hasMore: items.length === PAGE_SIZE, offset: items.length });
        }
      } catch {
        if (!controller.signal.aborted) setResult({ ...base, loading: false, error: true });
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, conversations, retry]);

  const current = result?.query === query && result.source === conversations ? result : null;
  const loading = !!query && (!current || current.loading);

  async function loadMore() {
    const controller = controllerRef.current;
    if (!current || loading || !current.hasMore || !controller || controller.signal.aborted) return;
    setResult({ ...current, loading: true, error: false });
    try {
      const items = await searchConversations(query, current.offset, PAGE_SIZE, controller.signal);
      if (!controller.signal.aborted) {
        const unique = new Map([...current.items, ...items].map((c) => [c.conversationId, c]));
        setResult({
          ...current, items: [...unique.values()], loading: false, error: false,
          hasMore: items.length === PAGE_SIZE, offset: current.offset + items.length,
        });
      }
    } catch {
      if (!controller.signal.aborted) setResult({ ...current, loading: false, error: true });
    }
  }

  return {
    input, setInput, searching: !!query, loading,
    items: query ? current?.items ?? [] : conversations,
    error: !!query && !!current?.error,
    hasMore: !!query && !!current?.hasMore,
    loadMore,
    retry: () => setRetry((value) => value + 1),
  };
}
