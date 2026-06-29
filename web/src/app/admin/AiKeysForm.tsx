"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./adminApi";
import type { AiKeyDto, AiKeysDto, CheckKeysResult, KeyCheckResult, Provider } from "./aiTypes";
import { Badge, Banner, Button, Card, TextArea } from "./ui";

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
    </div>
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
                        r.ok ? <Badge tone="green">✓ Valid</Badge> : <Badge tone="red">✕ Invalid</Badge>
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
