"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./adminApi";
import type { AiKeyUsage, ChatMessage, ChatTurnResponse, ModelInfo, ModelsResult, ProposedAction, Provider } from "./aiTypes";
import { Badge, Button, Select } from "./ui";

export default function AiChat() {
  const [provider, setProvider] = useState<Provider>("openrouter");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelWarning, setModelWarning] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [usage, setUsage] = useState<AiKeyUsage | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<ProposedAction | null>(null);
  const [typedConfirm, setTypedConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);

  // Preferred model per provider, restored from saved config.
  const preferred = useRef<{ gemini: string | null; openrouter: string | null }>({ gemini: null, openrouter: null });
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadModels = useCallback(async (p: Provider) => {
    setLoadingModels(true);
    setModels([]);
    setModelWarning(null);
    setUsage(null);
    const res = await api(`/api/admin/ai/models?provider=${p}`);
    setLoadingModels(false);
    if (!res.ok) {
      setModelWarning("Could not load models.");
      return;
    }
    const d: ModelsResult = await res.json();
    const sorted = sortModels(d.models);
    setModels(sorted);
    setModelWarning(d.warning);
    const want = preferred.current[p];
    setModel(sorted.find((m) => m.id === want)?.id ?? sorted[0]?.id ?? "");
    // Best-effort key usage/quota (OpenRouter exposes it; Gemini doesn't).
    void (async () => {
      const u = await api(`/api/admin/ai/usage?provider=${p}`);
      setUsage(u.ok ? await u.json() : null);
    })();
  }, []);

  // On mount: restore the saved provider/model, then load that provider's models.
  useEffect(() => {
    void (async () => {
      const res = await api("/api/admin/ai/config");
      let p: Provider = "openrouter";
      if (res.ok) {
        const c = await res.json();
        preferred.current = { gemini: c.geminiModel, openrouter: c.openRouterModel };
        if (c.selectedProvider === "gemini" || c.selectedProvider === "openrouter") p = c.selectedProvider;
      }
      setProvider(p);
      await loadModels(p);
    })();
  }, [loadModels]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, pending, error]);

  // Remember dismissed notices (e.g. the Gemini "no pricing" note) so they don't keep reappearing.
  useEffect(() => {
    try {
      const raw = localStorage.getItem("ev_admin_dismissed_notices");
      if (raw) setDismissed(JSON.parse(raw));
    } catch {}
  }, []);

  function dismissNotice(text: string) {
    setDismissed((d) => {
      const next = d.includes(text) ? d : [...d, text];
      try {
        localStorage.setItem("ev_admin_dismissed_notices", JSON.stringify(next));
      } catch {}
      return next;
    });
  }

  function persist(p: Provider, m: string) {
    const body = {
      selectedProvider: p,
      geminiModel: p === "gemini" ? m : preferred.current.gemini,
      openRouterModel: p === "openrouter" ? m : preferred.current.openrouter,
    };
    preferred.current[p] = m;
    void api("/api/admin/ai/config", { method: "PUT", body: JSON.stringify(body) });
  }

  async function changeProvider(p: Provider) {
    setProvider(p);
    await loadModels(p);
  }

  function changeModel(m: string) {
    setModel(m);
    persist(provider, m);
  }

  async function handleTurn(res: Response) {
    if (!res.ok) {
      setError("The request failed. Please try again.");
      return;
    }
    const data: ChatTurnResponse = await res.json();
    setMessages(data.messages);
    if (data.status === "proposal" && data.proposal) setPending(data.proposal);
    else if (data.status === "error") setError(data.error ?? "Something went wrong.");
  }

  async function send() {
    const content = input.trim();
    if (!content || busy || !model) return;
    const next: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    setError(null);
    setPending(null);
    setBusy(true);
    const res = await api("/api/admin/ai/chat", {
      method: "POST",
      body: JSON.stringify({ provider, model, messages: next }),
    });
    await handleTurn(res);
    setBusy(false);
  }

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    const res = await api("/api/admin/ai/chat/confirm", {
      method: "POST",
      body: JSON.stringify({ provider, model, messages, action: pending, typedConfirmation: typedConfirm }),
    });
    setPending(null);
    setTypedConfirm("");
    await handleTurn(res);
    setBusy(false);
  }

  function cancel() {
    if (!pending) return;
    // Answer the dangling tool call locally so the transcript stays valid for the next turn.
    setMessages((m) => [
      ...m,
      { role: "tool", toolCallId: pending.toolCallId, name: pending.toolName, content: "The admin declined this action." },
    ]);
    setPending(null);
    setTypedConfirm("");
  }

  const shown = models; // already sorted: free first, then paid cheapest → priciest
  const confirmReady = pending && (!pending.dangerous || typedConfirm.trim() === "CONFIRM");
  const canSend = !busy && !pending && !!model && !!input.trim();

  return (
    <div className="flex h-[74vh] flex-col rounded-xl border border-black/10 bg-white/60 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/3">
      {/* Toolbar: provider + model switcher */}
      <div className="flex flex-wrap items-center gap-3 border-b border-black/10 px-4 py-3 dark:border-white/10">
        <Select value={provider} onChange={(v) => changeProvider(v as Provider)} disabled={busy}>
          <option value="openrouter">OpenRouter</option>
          <option value="gemini">Gemini</option>
        </Select>
        <Select value={model} onChange={changeModel} disabled={busy || loadingModels || shown.length === 0}>
          {loadingModels && <option value="">Loading…</option>}
          {!loadingModels && shown.length === 0 && <option value="">No models</option>}
          {shown.map((m) => {
            // Only show a price suffix when there's a real price (or "Free") — skip "Pricing not exposed".
            const showPrice = m.isFree || m.promptPricePerMTok != null;
            return (
              <option key={m.id} value={m.id}>
                {m.name}
                {showPrice && m.priceLabel ? ` — ${m.priceLabel}` : ""}
              </option>
            );
          })}
        </Select>
        {messages.length > 0 && (
          <button
            onClick={() => {
              setMessages([]);
              setError(null);
              setPending(null);
            }}
            className="ml-auto text-xs text-black/50 hover:text-black/80 dark:text-white/50 dark:hover:text-white/80"
          >
            Clear chat
          </button>
        )}
      </div>

      {modelWarning && !dismissed.includes(modelWarning) && (
        <div className="flex items-start justify-between gap-3 border-b border-black/10 px-4 py-2 text-xs text-amber-700 dark:border-white/10 dark:text-amber-300">
          <span>{modelWarning}</span>
          <button
            onClick={() => dismissNotice(modelWarning)}
            aria-label="Dismiss"
            title="Don't show this again"
            className="shrink-0 rounded px-1 leading-none text-amber-700/70 hover:text-amber-900 dark:text-amber-300/70 dark:hover:text-amber-200"
          >
            ✕
          </button>
        </div>
      )}

      {usage?.supported && usage.summary && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-black/10 px-4 py-1.5 text-xs text-black/55 dark:border-white/10 dark:text-white/55">
          <span>💳 {usage.summary}</span>
          {usage.resetNote && <span className="text-black/40 dark:text-white/40">· {usage.resetNote}</span>}
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.filter((m) => m.role !== "system").length === 0 && (
          <div className="mx-auto mt-10 max-w-md text-center text-sm text-black/50 dark:text-white/50">
            <p className="text-3xl">💬</p>
            <p className="mt-2 font-medium text-black/70 dark:text-white/70">Ask the admin assistant</p>
            <p className="mt-1">
              It can look things up freely. Any change to the database is shown to you first and only runs after
              you confirm.
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <MessageBubble key={i} m={m} />
        ))}
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm whitespace-pre-wrap text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </div>
        )}
        {busy && <p className="text-sm text-black/40 dark:text-white/40">Thinking…</p>}
      </div>

      {/* Proposal / confirmation */}
      {pending && (
        <div className="border-t border-black/10 bg-amber-50/60 px-4 py-3 dark:border-white/10 dark:bg-amber-950/20">
          <div className="flex items-center gap-2">
            <Badge tone={pending.dangerous ? "red" : "amber"}>
              {pending.dangerous ? "⚠ Dangerous change" : "Pending change"}
            </Badge>
            <span className="text-xs text-black/50 dark:text-white/50">{pending.toolName}</span>
          </div>
          <p className="mt-2 text-sm font-medium">{pending.humanSummary}</p>
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-black/50 dark:text-white/50">Details</summary>
            <pre className="mt-1 overflow-x-auto rounded bg-black/5 p-2 text-xs dark:bg-white/5">{prettyArgs(pending.argumentsJson)}</pre>
          </details>
          {pending.dangerous && (
            <div className="mt-2">
              <label className="text-xs text-black/60 dark:text-white/60">
                This is destructive. Type <code className="font-mono font-semibold">CONFIRM</code> to enable the button:
              </label>
              <input
                value={typedConfirm}
                onChange={(e) => setTypedConfirm(e.target.value)}
                placeholder="CONFIRM"
                className="mt-1 block w-40 rounded-md border border-black/15 bg-transparent px-3 py-1.5 text-sm font-mono outline-none focus:border-red-500 dark:border-white/20"
              />
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <Button variant={pending.dangerous ? "danger" : "primary"} onClick={confirm} disabled={!confirmReady || busy}>
              Confirm &amp; run
            </Button>
            <Button variant="ghost" onClick={cancel} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Composer */}
      <div className="border-t border-black/10 px-4 py-3 dark:border-white/10">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder={pending ? "Resolve the pending change first…" : "Ask anything, or ask me to make a change…"}
            disabled={!!pending}
            className="flex-1 resize-none rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:opacity-50 dark:border-white/20"
          />
          <Button onClick={send} disabled={!canSend}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ m }: { m: ChatMessage }) {
  if (m.role === "user")
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-blue-600 px-3.5 py-2 text-sm whitespace-pre-wrap text-white">
          {m.content}
        </div>
      </div>
    );

  if (m.role === "tool")
    return (
      <details className="text-xs text-black/50 dark:text-white/50">
        <summary className="cursor-pointer">🔧 ran {m.name}</summary>
        <pre className="mt-1 overflow-x-auto rounded bg-black/5 p-2 dark:bg-white/5">{truncate(m.content ?? "", 1200)}</pre>
      </details>
    );

  if (m.role === "assistant") {
    const hasCalls = m.toolCalls && m.toolCalls.length > 0;
    if (!m.content && hasCalls)
      return (
        <div className="text-xs text-black/45 dark:text-white/45">
          🔧 calling {m.toolCalls!.map((t) => t.name).join(", ")}…
        </div>
      );
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-black/5 px-3.5 py-2 text-sm whitespace-pre-wrap dark:bg-white/10">
          {m.content}
        </div>
      </div>
    );
  }
  return null;
}

function sortModels(models: ModelInfo[]): ModelInfo[] {
  const priceOf = (m: ModelInfo) =>
    m.promptPricePerMTok != null || m.completionPricePerMTok != null
      ? (m.promptPricePerMTok ?? 0) + (m.completionPricePerMTok ?? 0)
      : Number.POSITIVE_INFINITY; // unknown price (e.g. Gemini) sinks below known-priced models
  return [...models].sort((a, b) => {
    if (a.isFree !== b.isFree) return a.isFree ? -1 : 1; // free first
    const pa = a.isFree ? 0 : priceOf(a);
    const pb = b.isFree ? 0 : priceOf(b);
    if (pa !== pb) return pa - pb; // cheapest → most expensive
    return a.name.localeCompare(b.name);
  });
}

function prettyArgs(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
