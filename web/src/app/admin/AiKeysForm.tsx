"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { api } from "./adminApi";
import type {
  AiKeyDto,
  AiKeysDto,
  CheckKeysResult,
  EmbeddingConfigDto,
  KeyCheckResult,
  ModelsResult,
  Provider,
} from "./aiTypes";
import { Badge, Banner, Button, Card, Select, TextArea } from "./ui";

export default function AiKeysForm() {
  const [data, setData] = useState<AiKeysDto>({ gemini: [], openRouter: [] });

  const reload = useCallback(async () => {
    const res = await api("/api/admin/ai/keys");
    if (res.ok) setData(await res.json());
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">AI provider keys</h1>
        <p className="mt-1 text-sm text-black/55 dark:text-white/55">
          Add one or more API keys per provider (one per line). Keys are encrypted before storage and never
          shown again. The chat assistant rotates through them — if one key fails it falls back to the next.
        </p>
      </div>

      <ProviderKeys
        provider="gemini"
        title="Gemini (Google AI Studio)"
        keyHelp="Get a key at aistudio.google.com → “Get API key”. Keys usually start with “AIza”."
        keys={data.gemini}
        onReload={reload}
      />
      <ProviderKeys
        provider="openrouter"
        title="OpenRouter"
        keyHelp="Create a key at openrouter.ai/keys. Keys usually start with “sk-or-”."
        keys={data.openRouter}
        onReload={reload}
      />

      <EmbeddingConfigCard />
    </div>
  );
}

function EmbeddingConfigCard() {
  const [cfg, setCfg] = useState<EmbeddingConfigDto | null>(null);
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [model, setModel] = useState("");
  const [dimensions, setDimensions] = useState(1536);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    const res = await api("/api/admin/ai/models?provider=gemini&kind=embedding");
    setLoadingModels(false);
    if (!res.ok) return;
    const d: ModelsResult = await res.json();
    setModels(d.models.map((m) => ({ id: m.id, name: m.name })));
    setModel((prev) => prev || d.models[0]?.id || "");
  }, []);

  useEffect(() => {
    void (async () => {
      const res = await api("/api/admin/ai/embedding-config");
      if (!res.ok) return;
      const d: EmbeddingConfigDto = await res.json();
      setCfg(d);
      if (d.model) setModel(d.model);
      if (d.dimensions) setDimensions(d.dimensions);
      if (!d.locked) void loadModels();
    })();
  }, [loadModels]);

  async function save() {
    if (!model) {
      setMsg({ kind: "error", text: "Choose an embedding model first." });
      return;
    }
    setBusy(true);
    setMsg(null);
    const res = await api("/api/admin/ai/embedding-config", {
      method: "PUT",
      body: JSON.stringify({ model, dimensions }),
    });
    setBusy(false);
    if (res.ok) {
      setCfg(await res.json());
      setMsg({ kind: "success", text: "Saved and locked." });
    } else {
      const d = await res.json().catch(() => ({}));
      setMsg({ kind: "error", text: d.error ?? "Could not save the embedding config." });
    }
  }

  return (
    <Card
      title="Memory embedding"
      subtitle="Used to turn saved chats into searchable vectors."
      right={cfg?.locked ? <Badge tone="green">Locked</Badge> : undefined}
    >
      <div className="space-y-4">
        <Banner kind="info">
          When set, end-user chats (text + audio) are saved so people can recall them. Each user&rsquo;s
          browser embeds their own messages with their <strong>own</strong> Gemini key using the model and
          dimension you pick here — your keys are never used for it. This choice is{" "}
          <strong>permanent</strong> (changing it would invalidate every saved vector), so pick once.
        </Banner>

        {cfg?.locked ? (
          <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
            <dt className="text-black/55 dark:text-white/55">Model</dt>
            <dd className="font-mono">{cfg.model}</dd>
            <dt className="text-black/55 dark:text-white/55">Dimension</dt>
            <dd className="font-mono">{cfg.dimensions}</dd>
          </dl>
        ) : (
          <>
            <label className="block">
              <span className="text-sm font-medium">Embedding model</span>
              <div className="mt-1">
                <Select value={model} onChange={setModel} disabled={busy || loadingModels}>
                  {loadingModels && <option value="">Loading…</option>}
                  {!loadingModels && models.length === 0 && <option value="">No embedding models (add a Gemini key)</option>}
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </div>
              <span className="mt-1 block text-xs text-black/55 dark:text-white/55">
                e.g. <code>gemini-embedding-001</code>. Loaded from your Gemini keys.
              </span>
            </label>

            <label className="block">
              <span className="text-sm font-medium">Vector dimension</span>
              <div className="mt-1">
                <Select value={String(dimensions)} onChange={(v) => setDimensions(Number(v))} disabled={busy}>
                  <option value="768">768 — lean</option>
                  <option value="1536">1536 — recommended</option>
                  <option value="3072">3072 — max quality</option>
                </Select>
              </div>
              <span className="mt-1 block text-xs text-black/55 dark:text-white/55">
                1536 ties 3072 on quality at half the storage. Cannot change after saving.
              </span>
            </label>

            {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
            <Button onClick={save} disabled={busy || !model}>
              Save &amp; lock
            </Button>
          </>
        )}
        {cfg?.locked && msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
      </div>
    </Card>
  );
}

function ProviderKeys({
  provider,
  title,
  keyHelp,
  keys,
  onReload,
}: {
  provider: Provider;
  title: string;
  keyHelp: string;
  keys: AiKeyDto[];
  onReload: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  // Validity is transient — held here only, shown after a manual check, never loaded from the server.
  const [results, setResults] = useState<Record<number, { ok: boolean; message: string }>>({});
  const [checkingId, setCheckingId] = useState<number | null>(null);

  async function add() {
    if (!text.trim()) return;
    setBusy(true);
    setMsg(null);
    const res = await api(`/api/admin/ai/keys/${provider}`, {
      method: "POST",
      body: JSON.stringify({ rawText: text }),
    });
    setBusy(false);
    if (res.ok) {
      setText("");
      await onReload();
      setMsg({ kind: "success", text: "Keys added." });
    } else {
      const d = await res.json().catch(() => ({}));
      setMsg({ kind: "error", text: d.error ?? "Could not add keys." });
    }
  }

  async function checkAll() {
    setBusy(true);
    setMsg(null);
    const res = await api(`/api/admin/ai/keys/${provider}/check`, { method: "POST" });
    setBusy(false);
    if (res.ok) {
      const d: CheckKeysResult = await res.json();
      setResults((prev) => {
        const next = { ...prev };
        for (const r of d.results) next[r.id] = { ok: r.ok, message: r.message };
        return next;
      });
      const ok = d.results.filter((r) => r.ok).length;
      setMsg({ kind: "info", text: `Checked ${d.results.length} key(s): ${ok} valid, ${d.results.length - ok} invalid.` });
    } else {
      setMsg({ kind: "error", text: "Could not check keys." });
    }
  }

  async function checkOne(id: number) {
    setCheckingId(id);
    setMsg(null);
    const res = await api(`/api/admin/ai/keys/${id}/check`, { method: "POST" });
    setCheckingId(null);
    if (res.ok) {
      const r: KeyCheckResult = await res.json();
      setResults((prev) => ({ ...prev, [r.id]: { ok: r.ok, message: r.message } }));
    } else {
      setMsg({ kind: "error", text: "Could not check the key." });
    }
  }

  async function remove(id: number) {
    setBusy(true);
    await api(`/api/admin/ai/keys/${id}`, { method: "DELETE" });
    await onReload();
    setConfirmId(null);
    setBusy(false);
  }

  return (
    <Card
      title={title}
      right={
        <Button variant="ghost" size="sm" onClick={checkAll} disabled={busy || keys.length === 0}>
          Check all keys
        </Button>
      }
    >
      <div className="space-y-4">
        {keys.length > 0 ? (
          <ul className="divide-y divide-black/5 rounded-lg border border-black/10 dark:divide-white/5 dark:border-white/10">
            {keys.map((k) => {
              const r = results[k.id];
              return (
                <li key={k.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-sm">{k.keyHint}</code>
                      {checkingId === k.id ? (
                        <Badge tone="gray">Checking…</Badge>
                      ) : r ? (
                        r.ok ? (
                          <Badge tone="green">
                            <Check size={12} aria-hidden="true" /> Valid
                          </Badge>
                        ) : (
                          <Badge tone="red">
                            <X size={12} aria-hidden="true" /> Invalid
                          </Badge>
                        )
                      ) : null}
                    </div>
                    {r && !r.ok && (
                      <p className="mt-0.5 truncate text-xs text-red-600 dark:text-red-400">{r.message}</p>
                    )}
                  </div>
                  {confirmId === k.id ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <span className="text-xs text-black/55 dark:text-white/55">Remove?</span>
                      <Button variant="danger" size="sm" onClick={() => remove(k.id)} disabled={busy}>
                        Confirm
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirmId(null)} disabled={busy}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => checkOne(k.id)} disabled={busy || checkingId === k.id}>
                        Check
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirmId(k.id)} disabled={busy}>
                        Remove
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-black/50 dark:text-white/50">No keys yet.</p>
        )}

        <TextArea
          label="Add keys (one per line)"
          value={text}
          onChange={setText}
          rows={3}
          mono
          placeholder={"key-1\nkey-2"}
          help={keyHelp}
        />

        {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}

        <div className="flex gap-2">
          <Button onClick={add} disabled={busy || !text.trim()}>
            Add keys
          </Button>
        </div>
      </div>
    </Card>
  );
}
