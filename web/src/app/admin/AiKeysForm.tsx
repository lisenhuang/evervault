"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
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
import { PREBUILT_VOICES } from "../webapp/lib/voices";
import { DEFAULT_LIVE_IDLE_SEC } from "../webapp/lib/store";
import { liveSupportsThinking } from "../webapp/lib/liveThinking";

// How long a live call may sit in user silence before it hangs itself up. Whole minutes only — the
// copy shown to the user is phrased in minutes — plus an explicit "never" (0) for admins who'd rather
// a call stay open until the user ends it. Values are seconds, matching the API.
const LIVE_IDLE_OPTIONS: { sec: number; label: string }[] = [
  { sec: 60, label: "1 minute" },
  { sec: 120, label: "2 minutes" },
  { sec: 180, label: "3 minutes" },
  { sec: 300, label: "5 minutes" },
  { sec: 600, label: "10 minutes" },
  { sec: 900, label: "15 minutes" },
  { sec: 1800, label: "30 minutes" },
  { sec: 3600, label: "1 hour" },
  { sec: 0, label: "Never — only the user ends the call" },
];

// How a sent voice message is answered. "live" streams the reply from one Gemini Live session (audio +
// text together, no separate transcribe/synthesize step — far faster), falling back to "tts" if a Live
// session can't start; "tts" is the classic transcribe → reply → synthesize pipeline.
const VOICE_MODE_OPTIONS: { value: string; label: string }[] = [
  { value: "live", label: "Gemini Live — fast (audio in, audio out)" },
  { value: "tts", label: "Classic — transcribe, reply, then speak" },
];

// How long a Gemini 3.x Live model may think before it answers. "auto" sends no thinkingConfig at all,
// leaving the model's own default (minimal for Live). Every step up buys deeper multi-step and tool
// reasoning and costs time before the first word — which on a call is silence, so the labels say so.
const LIVE_REASONING_OPTIONS: { value: string; label: string }[] = [
  { value: "auto", label: "Auto — the model's default (fastest)" },
  { value: "minimal", label: "Minimal — pinned to the fastest level" },
  { value: "low", label: "Low — a little thinking" },
  { value: "medium", label: "Medium — noticeably slower to start" },
  { value: "high", label: "High — deepest, slowest to start" },
];

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

// Ensures the currently-saved model id always appears as an option, even if the live model list hasn't
// loaded yet or no longer includes it — so the Select never renders blank or silently drops the value.
function withCurrent(options: { id: string; name: string }[], current: string): { id: string; name: string }[] {
  if (!current || options.some((o) => o.id === current)) return options;
  return [{ id: current, name: current }, ...options];
}

// A pickable text model with its provider. ChatGPT models carry the reasoning levels they support.
type TextOpt = { provider: "gemini" | "openai"; id: string; name: string; reasoningLevels?: string[] | null };

const PROVIDER_LABEL: Record<string, string> = { gemini: "Gemini", openai: "ChatGPT" };

// ChatGPT advertises its own reasoning-effort names; pretty-print them (mirrors the admin chat switcher).
function reasoningLabel(level: string): string {
  const map: Record<string, string> = {
    none: "None",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra High",
    max: "Max",
    ultra: "Ultra",
  };
  return map[level] ?? level.charAt(0).toUpperCase() + level.slice(1);
}

// Normalize a reasoning value for equality: "auto"/""/null all mean "the model's default".
function normReason(r: string | null | undefined): string {
  return !r || r === "auto" ? "" : r;
}

// One text-model picker (provider+model) plus, for ChatGPT, its reasoning level. Used for both the
// primary and the fallback (the fallback additionally offers "No fallback").
function TextModelRow({
  label,
  help,
  allowNone,
  loading,
  geminiOpts,
  openaiOpts,
  chatGptConnected,
  provider,
  model,
  reasoning,
  onSelectModel,
  onSelectReasoning,
  disabled,
}: {
  label: string;
  help?: ReactNode;
  allowNone?: boolean;
  loading: boolean;
  geminiOpts: TextOpt[];
  openaiOpts: TextOpt[];
  chatGptConnected: boolean;
  provider: string; // "" (none, fallback only) | "gemini" | "openai"
  model: string;
  reasoning: string; // "auto" | a level
  onSelectModel: (provider: string, model: string) => void;
  onSelectReasoning: (level: string) => void;
  disabled?: boolean;
}) {
  const value = provider && model ? `${provider}:${model}` : "";
  const optsFor = provider === "openai" ? openaiOpts : geminiOpts;
  // Keep a saved selection visible even if it isn't in the freshly-loaded list (still loading, or the
  // model was retired) so it's never silently dropped.
  const missing = !!provider && !!model && !optsFor.some((o) => o.id === model);

  const levels = provider === "openai" ? openaiOpts.find((o) => o.id === model)?.reasoningLevels ?? [] : [];
  const shownLevels = Array.from(
    new Set([...(levels ?? []), ...(reasoning && reasoning !== "auto" ? [reasoning] : [])]),
  );

  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <div className="mt-1 flex flex-wrap gap-2">
        <Select
          value={value}
          onChange={(v) => {
            if (!v) return onSelectModel("", "");
            const i = v.indexOf(":");
            onSelectModel(v.slice(0, i), v.slice(i + 1));
          }}
          disabled={disabled}
        >
          {loading && geminiOpts.length === 0 && openaiOpts.length === 0 && <option value={value}>Loading…</option>}
          {allowNone && <option value="">No fallback</option>}
          {missing && (
            <option value={value}>
              {(PROVIDER_LABEL[provider] ?? provider)} · {model} (saved)
            </option>
          )}
          {geminiOpts.length > 0 && (
            <optgroup label="Gemini">
              {geminiOpts.map((m) => (
                <option key={`gemini:${m.id}`} value={`gemini:${m.id}`}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          )}
          {openaiOpts.length > 0 && (
            <optgroup label={chatGptConnected ? "ChatGPT" : "ChatGPT (connect above)"}>
              {openaiOpts.map((m) => (
                <option key={`openai:${m.id}`} value={`openai:${m.id}`}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          )}
        </Select>

        {provider === "openai" &&
          (shownLevels.length > 0 ? (
            <Select value={reasoning || "auto"} onChange={onSelectReasoning} disabled={disabled}>
              <option value="auto">Reasoning: Auto</option>
              {shownLevels.map((lvl) => (
                <option key={lvl} value={lvl}>
                  Reasoning: {reasoningLabel(lvl)}
                </option>
              ))}
            </Select>
          ) : (
            <span className="self-center text-xs text-black/45 dark:text-white/45">
              Connect ChatGPT above to set a reasoning level.
            </span>
          ))}
      </div>
      {help && <span className="mt-1 block text-xs text-black/55 dark:text-white/55">{help}</span>}
    </label>
  );
}

function WebappModelsCard() {
  const [cfg, setCfg] = useState<WebappAiConfigDto | null>(null);
  const [chatModels, setChatModels] = useState<{ id: string; name: string }[]>([]);
  const [liveModels, setLiveModels] = useState<{ id: string; name: string }[]>([]);
  const [openaiModels, setOpenaiModels] = useState<TextOpt[]>([]);
  const [chatGptConnected, setChatGptConnected] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  // Primary text model.
  const [textProvider, setTextProvider] = useState("gemini");
  const [textModel, setTextModel] = useState("");
  const [textReasoning, setTextReasoning] = useState("auto");
  // Fallback text model (fbProvider = "" means none).
  const [fbProvider, setFbProvider] = useState("");
  const [fbModel, setFbModel] = useState("");
  const [fbReasoning, setFbReasoning] = useState("auto");
  const [audioModel, setAudioModel] = useState("");
  const [liveModel, setLiveModel] = useState("");
  // Voice-message replies: the Live model for the "live" path + the mode ("live" | "tts").
  const [voiceLiveModel, setVoiceLiveModel] = useState("");
  const [voiceMode, setVoiceMode] = useState("live");
  // Thinking level per Live leg. "auto" (the UI value for "no thinkingConfig") is stored as null.
  const [liveReasoning, setLiveReasoning] = useState("auto");
  const [voiceLiveReasoning, setVoiceLiveReasoning] = useState("auto");
  const [voice, setVoice] = useState("");
  // Idle auto-hang-up window for live calls, in seconds ("0" = never). Held as a string for <Select>.
  const [liveIdle, setLiveIdle] = useState(String(DEFAULT_LIVE_IDLE_SEC));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    const [chatRes, liveRes, openaiRes] = await Promise.all([
      api("/api/admin/ai/models?provider=gemini&kind=chat"),
      api("/api/admin/ai/models?provider=gemini&kind=live"),
      api("/api/admin/ai/models?provider=openai&kind=chat"),
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
    if (openaiRes.ok) {
      const d: ModelsResult = await openaiRes.json();
      setOpenaiModels(
        d.models.map((m) => ({ provider: "openai", id: m.id, name: m.name, reasoningLevels: m.reasoningLevels })),
      );
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const [cfgRes, oauthRes] = await Promise.all([
        api("/api/admin/ai/webapp-config"),
        api("/api/admin/ai/openai"),
      ]);
      if (cfgRes.ok) {
        const d: WebappAiConfigDto = await cfgRes.json();
        setCfg(d);
        setTextProvider(d.textProvider || "gemini");
        setTextModel(d.textModel);
        setTextReasoning(d.textReasoning || "auto");
        setFbProvider(d.textFallbackProvider || "");
        setFbModel(d.textFallbackModel || "");
        setFbReasoning(d.textFallbackReasoning || "auto");
        setAudioModel(d.audioModel);
        setLiveModel(d.liveModel);
        setVoiceLiveModel(d.voiceLiveModel);
        setVoiceMode(d.voiceMode === "tts" ? "tts" : "live");
        setLiveReasoning(d.liveReasoning || "auto");
        setVoiceLiveReasoning(d.voiceLiveReasoning || "auto");
        setVoice(d.defaultVoice);
        setLiveIdle(String(d.liveIdleTimeoutSeconds ?? DEFAULT_LIVE_IDLE_SEC));
      }
      if (oauthRes.ok) {
        const s = await oauthRes.json();
        setChatGptConnected(s?.connected === true);
      }
      await loadModels();
    })();
  }, [loadModels]);

  async function save() {
    setBusy(true);
    setMsg(null);
    const res = await api("/api/admin/ai/webapp-config", {
      method: "PUT",
      body: JSON.stringify({
        textModel,
        textProvider,
        // "" clears server-side; only ChatGPT carries a reasoning level.
        textReasoning: textProvider === "openai" ? textReasoning || "auto" : "",
        textFallbackProvider: fbProvider || "",
        textFallbackModel: fbProvider ? fbModel : "",
        textFallbackReasoning: fbProvider === "openai" ? fbReasoning || "auto" : "",
        audioModel,
        liveModel,
        voiceLiveModel,
        voiceMode,
        // "auto" is normalized to null server-side, i.e. send no thinkingConfig.
        liveReasoning,
        voiceLiveReasoning,
        defaultVoice: voice,
        liveIdleTimeoutSeconds: Number(liveIdle),
      }),
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
  const geminiTextOpts: TextOpt[] = chatModels
    .filter((m) => !/(tts|embedding|image|imagen|aqa)/i.test(m.id))
    .map((m) => ({ provider: "gemini", id: m.id, name: m.name }));
  const audioOptions = withCurrent(chatModels.filter((m) => /tts/i.test(m.id)), audioModel);
  const liveOptions = withCurrent(liveModels, liveModel);
  // Voice-message Live model reuses the same Live-API model list as the call.
  const voiceLiveOptions = withCurrent(liveModels, voiceLiveModel);
  // Only some Live models take a thinking level, and the two legs can be on different models — so each
  // select is gated on its OWN model. Where it isn't supported the client sends no thinkingConfig at
  // all (sending one would be rejected at setup and fail the session), so the control is disabled
  // rather than silently ignored. A stored level is kept, not cleared: switching back restores it.
  const liveThinkingOk = liveSupportsThinking(liveModel);
  const voiceLiveThinkingOk = liveSupportsThinking(voiceLiveModel);
  // A value set directly through the API needn't be one of our presets; surface it so the select never
  // renders blank and silently rewrites the stored setting on the next save.
  const idleOptions = LIVE_IDLE_OPTIONS.some((o) => String(o.sec) === liveIdle)
    ? LIVE_IDLE_OPTIONS
    : [...LIVE_IDLE_OPTIONS, { sec: Number(liveIdle), label: `${liveIdle} seconds` }];

  // Pick the reasoning valid for a newly chosen ChatGPT model (keep the current one if still supported).
  function reasoningForOpenAiModel(modelId: string, current: string): string {
    const lv = openaiModels.find((o) => o.id === modelId)?.reasoningLevels ?? [];
    return current && current !== "auto" && lv.includes(current) ? current : "auto";
  }

  function onPrimaryModel(p: string, m: string) {
    setTextProvider(p);
    setTextModel(m);
    setTextReasoning(p === "openai" ? reasoningForOpenAiModel(m, textReasoning) : "auto");
  }

  function onFallbackModel(p: string, m: string) {
    setFbProvider(p);
    setFbModel(m);
    setFbReasoning(p === "openai" ? reasoningForOpenAiModel(m, fbReasoning) : "auto");
  }

  const fallbackIncomplete = !!fbProvider && !fbModel;
  const dirty =
    !!cfg &&
    (textModel !== cfg.textModel ||
      textProvider !== (cfg.textProvider || "gemini") ||
      normReason(textReasoning) !== normReason(cfg.textReasoning) ||
      (fbProvider || "") !== (cfg.textFallbackProvider || "") ||
      (fbModel || "") !== (cfg.textFallbackModel || "") ||
      normReason(fbReasoning) !== normReason(cfg.textFallbackReasoning) ||
      audioModel !== cfg.audioModel ||
      liveModel !== cfg.liveModel ||
      voiceLiveModel !== cfg.voiceLiveModel ||
      voiceMode !== (cfg.voiceMode === "tts" ? "tts" : "live") ||
      normReason(liveReasoning) !== normReason(cfg.liveReasoning) ||
      normReason(voiceLiveReasoning) !== normReason(cfg.voiceLiveReasoning) ||
      voice !== cfg.defaultVoice ||
      Number(liveIdle) !== cfg.liveIdleTimeoutSeconds);

  return (
    <Card
      title="Webapp AI models"
      subtitle="Which models power the public /webapp chat (it's keyless — users don't pick)."
    >
      <div className="space-y-4">
        <Banner kind="info">
          The <strong>/webapp</strong> uses your pooled Gemini keys (and, for ChatGPT, your connected
          account), so these choices spend <strong>your</strong> quota. Pick capable but cost-appropriate
          models. Lists load from your keys; a saved value that isn&rsquo;t in the list still shows so it&rsquo;s
          never lost.
        </Banner>

        <div className="space-y-3 rounded-lg border border-black/10 p-3 dark:border-white/10">
          <TextModelRow
            label="Text model — primary"
            loading={loadingModels}
            geminiOpts={geminiTextOpts}
            openaiOpts={openaiModels}
            chatGptConnected={chatGptConnected}
            provider={textProvider}
            model={textModel}
            reasoning={textReasoning}
            onSelectModel={onPrimaryModel}
            onSelectReasoning={setTextReasoning}
            disabled={busy || loadingModels}
          />
          <TextModelRow
            label="Text model — fallback"
            allowNone
            loading={loadingModels}
            geminiOpts={geminiTextOpts}
            openaiOpts={openaiModels}
            chatGptConnected={chatGptConnected}
            provider={fbProvider}
            model={fbModel}
            reasoning={fbReasoning}
            onSelectModel={onFallbackModel}
            onSelectReasoning={setFbReasoning}
            disabled={busy || loadingModels}
          />
          <span className="block text-xs text-black/55 dark:text-white/55">
            Each can be Gemini or ChatGPT; the fallback takes over when the primary is unavailable. Text chat
            follows the primary — a ChatGPT primary runs through the backend on your connected account (voice
            messages are then answered from their transcript). Transcription, speech, memory extraction, and
            messages with images/files always use your first Gemini choice (primary if it&rsquo;s Gemini,
            otherwise the Gemini fallback).
          </span>
        </div>

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

        <div className="space-y-3 rounded-lg border border-black/10 p-3 dark:border-white/10">
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
            <span className="text-sm font-medium">Call thinking level</span>
            <div className="mt-1">
              <Select value={liveReasoning} onChange={setLiveReasoning} disabled={busy || !liveThinkingOk}>
                {LIVE_REASONING_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </Select>
            </div>
            <span className="mt-1 block text-xs text-black/55 dark:text-white/55">
              {liveThinkingOk ? (
                <>
                  How long the model may think before it starts speaking. On a live call that thinking time
                  is <strong>silence</strong> — the caller hears nothing until it begins. Higher levels can
                  help with multi-step requests and tool use (tasks, memory, search), so raise it only if
                  calls are getting those wrong, and expect a slower start in exchange.
                </>
              ) : (
                <>
                  Not available on this model — only Gemini 3.x Live models accept a thinking level. Any
                  level saved here stays put and applies again if you switch back to a 3.x model.
                </>
              )}
            </span>
          </label>
        </div>

        <div className="space-y-3 rounded-lg border border-black/10 p-3 dark:border-white/10">
          <label className="block">
            <span className="text-sm font-medium">Voice message replies</span>
            <div className="mt-1">
              <Select value={voiceMode} onChange={setVoiceMode} disabled={busy}>
                {VOICE_MODE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </Select>
            </div>
            <span className="mt-1 block text-xs text-black/55 dark:text-white/55">
              How a sent voice message is answered. <strong>Gemini Live</strong> replies from one streaming
              session — audio and text together, with no separate transcription or synthesis step — so it&rsquo;s
              much faster, and it falls back to Classic automatically if a Live session can&rsquo;t start.{" "}
              <strong>Classic</strong> uses the transcribe → reply → speak pipeline (the voice model above).
            </span>
          </label>
          <label className="block">
            <span className="text-sm font-medium">Voice message Live model</span>
            <div className="mt-1">
              <Select
                value={voiceLiveModel}
                onChange={setVoiceLiveModel}
                disabled={busy || loadingModels || voiceMode !== "live"}
              >
                {loadingModels && voiceLiveOptions.length === 0 && <option value="">Loading…</option>}
                {voiceLiveOptions.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </Select>
            </div>
            <span className="mt-1 block text-xs text-black/55 dark:text-white/55">
              The Gemini Live model that answers voice messages when the mode above is Gemini Live. Needs a
              Live-API model (same list as the call).
            </span>
          </label>
          <label className="block">
            <span className="text-sm font-medium">Voice message thinking level</span>
            <div className="mt-1">
              <Select
                value={voiceLiveReasoning}
                onChange={setVoiceLiveReasoning}
                disabled={busy || voiceMode !== "live" || !voiceLiveThinkingOk}
              >
                {LIVE_REASONING_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </Select>
            </div>
            <span className="mt-1 block text-xs text-black/55 dark:text-white/55">
              {voiceLiveThinkingOk ? (
                <>
                  Set separately from the call, because the trade-off is different: the user has already
                  sent the clip and is waiting for one reply, so extra thinking reads as a slower answer
                  rather than dead air in a conversation. This is the safer place to try a higher level.
                </>
              ) : (
                <>
                  Not available on this model — only Gemini 3.x Live models accept a thinking level. Any
                  level saved here stays put and applies again if you switch back to a 3.x model.
                </>
              )}
            </span>
          </label>
        </div>

        <label className="block">
          <span className="text-sm font-medium">End an idle call after</span>
          <div className="mt-1">
            <Select value={liveIdle} onChange={setLiveIdle} disabled={busy}>
              {idleOptions.map((o) => (
                <option key={o.sec} value={String(o.sec)}>{o.label}</option>
              ))}
            </Select>
          </div>
          <span className="mt-1 block text-xs text-black/55 dark:text-white/55">
            How long a call may sit in silence before it hangs up on its own. Only the user&rsquo;s quiet
            time counts — the timer resets whenever either side is speaking, so a long answer or an active
            back-and-forth never ends the call. A live call bills for the whole time it stays open, so
            &ldquo;Never&rdquo; means an abandoned call keeps spending your quota until the tab closes.
          </span>
        </label>

        <label className="block">
          <span className="text-sm font-medium">Default voice</span>
          <div className="mt-1">
            <Select value={voice} onChange={setVoice} disabled={busy}>
              {PREBUILT_VOICES.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name} — {v.mood} ({v.gender})
                </option>
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
          <Button
            onClick={save}
            disabled={busy || !dirty || !textModel || !audioModel || !liveModel || !voiceLiveModel || fallbackIncomplete}
          >
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
  const [results, setResults] = useState<
    Record<number, { ok: boolean; message: string; embeddingOk?: boolean | null; embeddingMessage?: string | null }>
  >({});
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
        for (const r of d.results)
          next[r.id] = { ok: r.ok, message: r.message, embeddingOk: r.embeddingOk, embeddingMessage: r.embeddingMessage };
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
      setResults((prev) => ({
        ...prev,
        [r.id]: { ok: r.ok, message: r.message, embeddingOk: r.embeddingOk, embeddingMessage: r.embeddingMessage },
      }));
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
                      {/* Embedding capability — set only for Gemini keys (probes gemini-embedding-002). */}
                      {checkingId !== k.id && r && r.ok && r.embeddingOk != null ? (
                        r.embeddingOk ? (
                          <Badge tone="green">
                            <Check size={12} aria-hidden="true" /> Embedding
                          </Badge>
                        ) : (
                          <Badge tone="red">
                            <X size={12} aria-hidden="true" /> No embedding
                          </Badge>
                        )
                      ) : null}
                    </div>
                    {r && !r.ok && (
                      <p className="mt-0.5 truncate text-xs text-red-600 dark:text-red-400">{r.message}</p>
                    )}
                    {r && r.ok && r.embeddingOk === false && r.embeddingMessage && (
                      <p className="mt-0.5 truncate text-xs text-red-600 dark:text-red-400">{r.embeddingMessage}</p>
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
