"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Gauge, Link2, X } from "lucide-react";
import { api } from "./adminApi";
import type {
  AiKeyDto,
  AiKeysDto,
  ChatConfigDto,
  CheckKeysResult,
  EmbeddingConfigDto,
  KeyCheckResult,
  ModelsResult,
  OpenAiStatus,
  Provider,
  WebappAiConfigDto,
} from "./aiTypes";
import { Badge, Banner, Button, Card, Field, Select, TextArea } from "./ui";

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

      <ChatGptOAuthCard />

      <ReasoningEffortCard />

      <WebappModelsCard />

      <EmbeddingConfigCard />
    </div>
  );
}

// The 30 prebuilt Gemini TTS/Live voices (same set the webapp offers). Kept here so the admin can pick
// the /webapp's default voice without loading the webapp bundle.
const WEBAPP_VOICES = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe",
  "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi",
  "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
  "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
];

// Ensures the currently-saved model id always appears as an option, even if the live model list hasn't
// loaded yet or no longer includes it — so the Select never renders blank or silently drops the value.
function withCurrent(options: { id: string; name: string }[], current: string): { id: string; name: string }[] {
  if (!current || options.some((o) => o.id === current)) return options;
  return [{ id: current, name: current }, ...options];
}

function WebappModelsCard() {
  const [cfg, setCfg] = useState<WebappAiConfigDto | null>(null);
  const [chatModels, setChatModels] = useState<{ id: string; name: string }[]>([]);
  const [liveModels, setLiveModels] = useState<{ id: string; name: string }[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [textModel, setTextModel] = useState("");
  const [audioModel, setAudioModel] = useState("");
  const [liveModel, setLiveModel] = useState("");
  const [voice, setVoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    const [chatRes, liveRes] = await Promise.all([
      api("/api/admin/ai/models?provider=gemini&kind=chat"),
      api("/api/admin/ai/models?provider=gemini&kind=live"),
    ]);
    setLoadingModels(false);
    if (chatRes.ok) {
      const d: ModelsResult = await chatRes.json();
      setChatModels(d.models.map((m) => ({ id: m.id, name: m.name })));
    }
    if (liveRes.ok) {
      const d: ModelsResult = await liveRes.json();
      setLiveModels(d.models.map((m) => ({ id: m.id, name: m.name })));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const res = await api("/api/admin/ai/webapp-config");
      if (res.ok) {
        const d: WebappAiConfigDto = await res.json();
        setCfg(d);
        setTextModel(d.textModel);
        setAudioModel(d.audioModel);
        setLiveModel(d.liveModel);
        setVoice(d.defaultVoice);
      }
      await loadModels();
    })();
  }, [loadModels]);

  async function save() {
    setBusy(true);
    setMsg(null);
    const res = await api("/api/admin/ai/webapp-config", {
      method: "PUT",
      body: JSON.stringify({ textModel, audioModel, liveModel, defaultVoice: voice }),
    });
    setBusy(false);
    if (res.ok) {
      setCfg(await res.json());
      setMsg({ kind: "success", text: "Saved. New /webapp sessions will use these." });
    } else {
      const d = await res.json().catch(() => ({}));
      setMsg({ kind: "error", text: d.error ?? "Could not save the webapp models." });
    }
  }

  // Text = chat-capable models minus the specialized ones; Voice = the TTS models; Live = bidi models.
  const textOptions = withCurrent(
    chatModels.filter((m) => !/(tts|embedding|image|imagen|aqa)/i.test(m.id)),
    textModel,
  );
  const audioOptions = withCurrent(chatModels.filter((m) => /tts/i.test(m.id)), audioModel);
  const liveOptions = withCurrent(liveModels, liveModel);

  const dirty =
    !!cfg &&
    (textModel !== cfg.textModel ||
      audioModel !== cfg.audioModel ||
      liveModel !== cfg.liveModel ||
      voice !== cfg.defaultVoice);

  return (
    <Card
      title="Webapp AI models"
      subtitle="Which Gemini models power the public /webapp chat (it's keyless — users don't pick)."
    >
      <div className="space-y-4">
        <Banner kind="info">
          The <strong>/webapp</strong> uses your pooled Gemini keys, so these choices spend{" "}
          <strong>your</strong> quota. Pick capable but cost-appropriate models. Lists load from your Gemini
          keys; a saved value that isn&rsquo;t in the list still shows so it&rsquo;s never lost.
        </Banner>

        <label className="block">
          <span className="text-sm font-medium">Text model</span>
          <div className="mt-1">
            <Select value={textModel} onChange={setTextModel} disabled={busy || loadingModels}>
              {loadingModels && textOptions.length === 0 && <option value="">Loading…</option>}
              {textOptions.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </Select>
          </div>
          <span className="mt-1 block text-xs text-black/55 dark:text-white/55">
            Powers text chat, transcription, and memory extraction.
          </span>
        </label>

        <label className="block">
          <span className="text-sm font-medium">Voice (speech) model</span>
          <div className="mt-1">
            <Select value={audioModel} onChange={setAudioModel} disabled={busy || loadingModels}>
              {loadingModels && audioOptions.length === 0 && <option value="">Loading…</option>}
              {audioOptions.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </Select>
          </div>
          <span className="mt-1 block text-xs text-black/55 dark:text-white/55">
            Speaks replies to voice messages. Must be a TTS model.
          </span>
        </label>

        <label className="block">
          <span className="text-sm font-medium">Live voice-call model</span>
          <div className="mt-1">
            <Select value={liveModel} onChange={setLiveModel} disabled={busy || loadingModels}>
              {loadingModels && liveOptions.length === 0 && <option value="">Loading…</option>}
              {liveOptions.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </Select>
          </div>
          <span className="mt-1 block text-xs text-black/55 dark:text-white/55">
            Real-time hands-free calls (the call button). Needs a Live-API model.
          </span>
        </label>

        <label className="block">
          <span className="text-sm font-medium">Default voice</span>
          <div className="mt-1">
            <Select value={voice} onChange={setVoice} disabled={busy}>
              {WEBAPP_VOICES.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </Select>
          </div>
          <span className="mt-1 block text-xs text-black/55 dark:text-white/55">
            The starting voice for spoken replies and live calls; users can change it in webapp settings.{" "}
            <a
              href="https://ai.google.dev/gemini-api/docs/speech-generation#voices"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-black/80 dark:hover:text-white/80"
            >
              Preview all voices
            </a>
            .
          </span>
        </label>

        {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}

        <div className="flex items-center gap-2">
          <Button onClick={save} disabled={busy || !dirty || !textModel || !audioModel || !liveModel}>
            Save
          </Button>
          <Button variant="ghost" size="sm" onClick={loadModels} disabled={busy || loadingModels}>
            {loadingModels ? "Loading models…" : "Reload models"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ChatGptOAuthCard() {
  const [status, setStatus] = useState<OpenAiStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [redirectUrl, setRedirectUrl] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);

  const reload = useCallback(async () => {
    const res = await api("/api/admin/ai/openai");
    if (res.ok) setStatus(await res.json());
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function startConnect() {
    setBusy(true);
    setMsg(null);
    const res = await api("/api/admin/ai/openai/connect/start", { method: "POST" });
    setBusy(false);
    if (res.ok) {
      const { authorizeUrl } = await res.json();
      window.open(authorizeUrl, "_blank", "noopener,noreferrer");
      setPasteOpen(true);
    } else {
      setMsg({ kind: "error", text: "Could not start the ChatGPT login." });
    }
  }

  async function finishConnect() {
    if (!redirectUrl.trim()) return;
    setBusy(true);
    setMsg(null);
    const res = await api("/api/admin/ai/openai/connect/complete", {
      method: "POST",
      body: JSON.stringify({ redirectUrl }),
    });
    setBusy(false);
    if (res.ok) {
      setStatus(await res.json());
      setPasteOpen(false);
      setRedirectUrl("");
      setMsg({ kind: "success", text: "ChatGPT connected." });
    } else {
      const d = await res.json().catch(() => ({}));
      setMsg({ kind: "error", text: d.error ?? "Could not complete the login." });
    }
  }

  async function disconnect() {
    setBusy(true);
    await api("/api/admin/ai/openai/connect", { method: "DELETE" });
    setPasteOpen(false);
    setConfirmDisconnect(false);
    await reload();
    setBusy(false);
    setMsg(null);
  }

  const connected = status?.connected === true;

  return (
    <Card
      title="ChatGPT (Sign in with ChatGPT)"
      subtitle="Chat with your paid ChatGPT plan via OAuth — no API key."
      right={connected ? <Badge tone="green"><Check size={12} aria-hidden="true" /> Connected</Badge> : <Badge tone="gray">Not connected</Badge>}
    >
      <div className="space-y-4">
        <Banner kind="info">
          Uses the Codex “Sign in with ChatGPT” flow to chat on your <strong>paid</strong> ChatGPT plan
          (Plus/Pro/Team). This is an <strong>unofficial</strong> backend — it may rate-limit or change without
          notice. Your tokens are encrypted before storage and never shown again.
        </Banner>

        {connected ? (
          <>
            <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
              <dt className="text-black/55 dark:text-white/55">Account</dt>
              <dd className="font-medium">{status?.email ?? "ChatGPT account"}</dd>
              <dt className="text-black/55 dark:text-white/55">Token renews</dt>
              <dd className="text-black/70 dark:text-white/70">
                {status?.expiresAt ? new Date(status.expiresAt).toLocaleString() : "—"}{" "}
                <span className="text-black/45 dark:text-white/45">(auto-refreshed)</span>
              </dd>
            </dl>
            {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
            {confirmDisconnect ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-black/60 dark:text-white/60">
                  Disconnect this ChatGPT account? You’ll need to sign in again to reconnect.
                </span>
                <Button variant="danger" size="sm" onClick={disconnect} disabled={busy}>
                  Confirm
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmDisconnect(false)} disabled={busy}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button variant="danger" onClick={() => setConfirmDisconnect(true)} disabled={busy}>
                Disconnect
              </Button>
            )}
          </>
        ) : (
          <>
            {!pasteOpen ? (
              <>
                {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
                <Button onClick={startConnect} disabled={busy}>
                  <Link2 size={14} aria-hidden="true" /> Connect ChatGPT
                </Button>
              </>
            ) : (
              <>
                <Banner kind="warning">
                  A ChatGPT sign-in tab was opened. After you approve, the browser will try to open a{" "}
                  <code>localhost:1455</code> page that <strong>won’t load — that’s expected</strong>. Copy the{" "}
                  <strong>full URL</strong> from that tab’s address bar and paste it below.
                </Banner>
                <Field
                  label="Redirected URL"
                  value={redirectUrl}
                  onChange={setRedirectUrl}
                  placeholder="http://localhost:1455/auth/callback?code=…&state=…"
                  help="The whole address you were redirected to after signing in."
                />
                {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
                <div className="flex gap-2">
                  <Button onClick={finishConnect} disabled={busy || !redirectUrl.trim()}>
                    Finish connecting
                  </Button>
                  <Button variant="ghost" onClick={() => setPasteOpen(false)} disabled={busy}>
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

const EFFORT_OPTIONS: { value: string; label: string }[] = [
  { value: "auto", label: "Auto — let each model decide (default)" },
  { value: "off", label: "Off — minimal thinking, fastest" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High — deepest reasoning, slowest" },
];

function ReasoningEffortCard() {
  const [cfg, setCfg] = useState<ChatConfigDto | null>(null);
  const [effort, setEffort] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await api("/api/admin/ai/config");
      if (!res.ok) return;
      const d: ChatConfigDto = await res.json();
      setCfg(d);
      setEffort(d.reasoningEffort ?? "auto");
    })();
  }, []);

  async function change(next: string) {
    const prev = effort;
    setEffort(next);
    setBusy(true);
    setMsg(null);
    // Send the full config so provider/model are preserved (even against an older backend).
    const res = await api("/api/admin/ai/config", {
      method: "PUT",
      body: JSON.stringify({
        selectedProvider: cfg?.selectedProvider ?? null,
        geminiModel: cfg?.geminiModel ?? null,
        openRouterModel: cfg?.openRouterModel ?? null,
        reasoningEffort: next,
      }),
    });
    setBusy(false);
    if (res.ok) {
      setCfg(await res.json());
      setMsg({ kind: "success", text: "Saved." });
    } else {
      setEffort(prev);
      setMsg({ kind: "error", text: "Could not save the reasoning effort." });
    }
  }

  return (
    <Card
      title="Reasoning effort"
      subtitle="How hard the chat model thinks before answering."
      right={
        <Badge tone="gray">
          <Gauge size={12} aria-hidden="true" /> {effort}
        </Badge>
      }
    >
      <div className="space-y-4">
        <Banner kind="info">
          Applies to the admin chat for <strong>both Gemini and OpenRouter</strong>. On Gemini it maps to the
          thinking level (3.x) or thinking budget (2.5); on OpenRouter to the reasoning effort. Higher digs
          deeper but is slower and uses more tokens. Models without a thinking mode (e.g. Gemini 1.5/2.0)
          ignore it.
        </Banner>

        <label className="block">
          <span className="text-sm font-medium">Effort level</span>
          <div className="mt-1">
            <Select value={effort} onChange={change} disabled={busy}>
              {EFFORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
        </label>

        {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
      </div>
    </Card>
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
            <Banner kind="warning">
              Semantic memory is <strong>off</strong> until you lock a model. Chats are still saved, but the
              AI can only recall them by keyword — not by meaning. Lock a model below to turn on smart recall.
            </Banner>

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
