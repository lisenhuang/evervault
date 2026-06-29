"use client";

import { useEffect, useState } from "react";
import { Eye, EyeOff, KeyRound, RefreshCw, Trash2, X } from "lucide-react";
import { audioModels, liveModels, type ModelInfo, PREBUILT_VOICES, textModels } from "./lib/gemini";

export default function KeyDrawer({
  open,
  onClose,
  apiKey,
  onSaveKey,
  onClearKey,
  models,
  modelsLoading,
  modelsError,
  onReloadModels,
  textModel,
  audioModel,
  liveModel,
  voice,
  onChangeTextModel,
  onChangeAudioModel,
  onChangeLiveModel,
  onChangeVoice,
}: {
  open: boolean;
  onClose: () => void;
  apiKey: string;
  onSaveKey: (key: string) => void;
  onClearKey: () => void;
  models: ModelInfo[] | null;
  modelsLoading: boolean;
  modelsError: string;
  onReloadModels: () => void;
  textModel: string;
  audioModel: string;
  liveModel: string;
  voice: string;
  onChangeTextModel: (v: string) => void;
  onChangeAudioModel: (v: string) => void;
  onChangeLiveModel: (v: string) => void;
  onChangeVoice: (v: string) => void;
}) {
  const [draft, setDraft] = useState(apiKey);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (open) setDraft(apiKey);
  }, [open, apiKey]);

  const texts = models ? textModels(models) : [];
  const audios = models ? audioModels(models) : [];
  const lives = models ? liveModels(models) : [];
  const selectCls =
    "mt-1 w-full rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm outline-none transition focus:border-blue-500 dark:border-white/20 dark:bg-neutral-900";

  return (
    <div className={`fixed inset-0 z-30 ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
      <div
        className={`absolute inset-0 bg-black/30 backdrop-blur-sm transition-opacity ${open ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
      />
      <aside
        className={`absolute top-0 right-0 flex h-full w-full max-w-md flex-col border-l border-black/10 bg-white shadow-xl transition-transform dark:border-white/10 dark:bg-neutral-950 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <header className="flex items-center justify-between border-b border-black/10 px-5 py-4 dark:border-white/10">
          <h2 className="font-semibold">Settings</h2>
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-black/5 dark:hover:bg-white/10" aria-label="Close">
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          {/* API key */}
          <section>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <KeyRound size={15} /> Your Gemini API key
            </h3>
            <div className="mt-2 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
              Stored <strong>only in this browser</strong> and sent only to Google — never to EverVault’s
              servers. Get a free key at{" "}
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                aistudio.google.com/apikey
              </a>
              .
            </div>
            <div className="mt-3 flex items-stretch gap-2">
              <div className="relative flex-1">
                <input
                  type={show ? "text" : "password"}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="AIza…"
                  className="w-full rounded-lg border border-black/15 bg-transparent px-3 py-2 pr-9 text-sm outline-none transition focus:border-blue-500 dark:border-white/20"
                />
                <button
                  type="button"
                  onClick={() => setShow((s) => !s)}
                  className="absolute top-1/2 right-2 -translate-y-1/2 text-black/40 hover:text-black/70 dark:text-white/40 dark:hover:text-white/70"
                  aria-label={show ? "Hide key" : "Show key"}
                >
                  {show ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <button
                onClick={() => onSaveKey(draft.trim())}
                disabled={!draft.trim() || draft.trim() === apiKey}
                className="rounded-lg bg-blue-600 px-4 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
              >
                Save
              </button>
            </div>
            {apiKey && (
              <button
                onClick={onClearKey}
                className="mt-2 inline-flex items-center gap-1.5 text-xs text-red-600 hover:underline dark:text-red-400"
              >
                <Trash2 size={13} /> Remove key from this browser
              </button>
            )}
          </section>

          {/* Models */}
          <section>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Models</h3>
              <button
                onClick={onReloadModels}
                disabled={!apiKey || modelsLoading}
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-black/60 hover:bg-black/5 disabled:opacity-50 dark:text-white/60 dark:hover:bg-white/10"
              >
                <RefreshCw size={13} className={modelsLoading ? "animate-spin" : ""} /> Refresh
              </button>
            </div>

            {!apiKey ? (
              <p className="mt-2 text-xs text-black/50 dark:text-white/50">Add your API key to load models.</p>
            ) : modelsError ? (
              <p className="mt-2 text-xs text-red-600 dark:text-red-400">{modelsError}</p>
            ) : (
              <div className="mt-3 space-y-4">
                <label className="block">
                  <span className="text-xs font-medium text-black/70 dark:text-white/70">Text model</span>
                  <select value={textModel} onChange={(e) => onChangeTextModel(e.target.value)} className={selectCls}>
                    {texts.length === 0 && <option value={textModel}>{textModel}</option>}
                    {texts.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.displayName}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="text-xs font-medium text-black/70 dark:text-white/70">Voice (speech) model</span>
                  <select value={audioModel} onChange={(e) => onChangeAudioModel(e.target.value)} className={selectCls}>
                    {audios.length === 0 && <option value={audioModel}>{audioModel}</option>}
                    {audios.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.displayName}
                      </option>
                    ))}
                  </select>
                  <span className="mt-1 block text-xs text-black/45 dark:text-white/45">
                    Used to speak replies to voice messages.
                  </span>
                </label>

                <label className="block">
                  <span className="text-xs font-medium text-black/70 dark:text-white/70">Live voice-call model</span>
                  <select value={liveModel} onChange={(e) => onChangeLiveModel(e.target.value)} className={selectCls}>
                    {lives.length === 0 && <option value={liveModel}>{liveModel}</option>}
                    {lives.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.displayName}
                      </option>
                    ))}
                  </select>
                  <span className="mt-1 block text-xs text-black/45 dark:text-white/45">
                    Real-time hands-free calls (the 📞 button). Needs a Live-API model.
                  </span>
                </label>

                <label className="block">
                  <span className="text-xs font-medium text-black/70 dark:text-white/70">Voice</span>
                  <select value={voice} onChange={(e) => onChangeVoice(e.target.value)} className={selectCls}>
                    {PREBUILT_VOICES.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}
