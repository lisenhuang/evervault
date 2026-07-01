"use client";

import { useEffect, useState } from "react";
import { ClipboardPaste, Eye, EyeOff, KeyRound, RefreshCw, Trash2, X } from "lucide-react";
import { audioModels, liveModels, type ModelInfo, PREBUILT_VOICES, textModels } from "./lib/gemini";
import { DEFAULT_AUDIO_MODEL, DEFAULT_LIVE_MODEL, DEFAULT_TEXT_MODEL } from "./lib/store";
import ModelSelect from "./ModelSelect";
import VoicePreviewButton from "./VoicePreviewButton";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useT } from "@/i18n/LanguageProvider";

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
  const t = useT();
  const [draft, setDraft] = useState(apiKey);
  const [show, setShow] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    if (open) setDraft(apiKey);
  }, [open, apiKey]);

  async function pasteKey() {
    try {
      const v = (await navigator.clipboard.readText()).trim();
      if (v) setDraft(v);
    } catch {
      /* clipboard read blocked/denied — no-op */
    }
  }

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
          <h2 className="font-semibold">{t.settings.title}</h2>
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-black/5 dark:hover:bg-white/10" aria-label={t.settings.close}>
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          {/* API key */}
          <section>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <KeyRound size={15} /> {t.settings.apiKeyTitle}
            </h3>
            <div className="mt-2 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
              {t.settings.apiKeyNotePrefix}
              <strong>{t.settings.apiKeyNoteBold}</strong>
              {t.settings.apiKeyNoteMid}
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                aistudio.google.com/apikey
              </a>
              {t.settings.apiKeyNoteSuffix}
            </div>
            <div className="mt-3 flex items-stretch gap-2">
              <div className="relative flex-1">
                <input
                  type={show ? "text" : "password"}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="AIza…"
                  className="w-full rounded-lg border border-black/15 bg-transparent px-3 py-2 pr-9 text-base outline-none transition focus:border-blue-500 md:text-sm dark:border-white/20"
                />
                {draft ? (
                  <button
                    type="button"
                    onClick={() => setShow((s) => !s)}
                    className="absolute top-1/2 right-2 -translate-y-1/2 text-black/40 hover:text-black/70 dark:text-white/40 dark:hover:text-white/70"
                    aria-label={show ? t.settings.hideKey : t.settings.showKey}
                  >
                    {show ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={pasteKey}
                    className="absolute top-1/2 right-2 -translate-y-1/2 text-black/40 hover:text-black/70 dark:text-white/40 dark:hover:text-white/70"
                    aria-label={t.settings.pasteKey}
                  >
                    <ClipboardPaste size={16} />
                  </button>
                )}
              </div>
              <button
                onClick={() => onSaveKey(draft.trim())}
                disabled={!draft.trim() || draft.trim() === apiKey}
                className="rounded-lg bg-blue-600 px-4 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
              >
                {t.settings.save}
              </button>
            </div>
            {apiKey && (
              <button
                onClick={() => setConfirmRemove(true)}
                className="mt-2 inline-flex items-center gap-1.5 text-xs text-black/50 transition hover:text-black/80 dark:text-white/50 dark:hover:text-white/80"
              >
                <Trash2 size={13} /> {t.settings.removeKey}
              </button>
            )}
          </section>

          {/* Models */}
          <section>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">{t.settings.models}</h3>
              <button
                onClick={onReloadModels}
                disabled={!apiKey || modelsLoading}
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-black/60 hover:bg-black/5 disabled:opacity-50 dark:text-white/60 dark:hover:bg-white/10"
              >
                <RefreshCw size={13} className={modelsLoading ? "animate-spin" : ""} /> {t.settings.refresh}
              </button>
            </div>

            {!apiKey ? (
              <p className="mt-2 text-xs text-black/50 dark:text-white/50">{t.settings.addKeyToLoad}</p>
            ) : modelsError ? (
              <p className="mt-2 text-xs text-red-600 dark:text-red-400">{modelsError}</p>
            ) : (
              <div className="mt-3 space-y-4">
                <ModelSelect
                  label={t.settings.textModel}
                  value={textModel}
                  options={texts}
                  recommendedId={DEFAULT_TEXT_MODEL}
                  onChange={onChangeTextModel}
                />

                <ModelSelect
                  label={t.settings.voiceModel}
                  value={audioModel}
                  options={audios}
                  recommendedId={DEFAULT_AUDIO_MODEL}
                  onChange={onChangeAudioModel}
                  hint={t.settings.voiceModelHint}
                />

                <ModelSelect
                  label={t.settings.liveModel}
                  value={liveModel}
                  options={lives}
                  recommendedId={DEFAULT_LIVE_MODEL}
                  onChange={onChangeLiveModel}
                  hint={t.settings.liveModelHint}
                />

                <label className="block">
                  <span className="text-xs font-medium text-black/70 dark:text-white/70">{t.settings.voice}</span>
                  <select value={voice} onChange={(e) => onChangeVoice(e.target.value)} className={selectCls}>
                    {[...PREBUILT_VOICES]
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((v) => (
                        <option key={v.name} value={v.name}>
                          {v.name} — {v.mood} · {v.gender}
                        </option>
                      ))}
                  </select>
                  <VoicePreviewButton voice={voice} model={audioModel} />
                  <span className="mt-1 block text-xs text-black/45 dark:text-white/45">
                    {t.settings.voiceHintPrefix}
                    <a
                      href="https://ai.google.dev/gemini-api/docs/speech-generation#voices"
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2 hover:text-black/70 dark:hover:text-white/70"
                    >
                      {t.settings.voiceHintLink}
                    </a>
                    {t.settings.voiceHintSuffix}
                  </span>
                </label>
              </div>
            )}
          </section>
        </div>
      </aside>
      <ConfirmDialog
        open={confirmRemove}
        title={t.settings.removeKeyConfirmTitle}
        message={t.settings.removeKeyConfirmBody}
        confirmLabel={t.settings.removeKeyConfirmButton}
        cancelLabel={t.common.cancel}
        onConfirm={() => {
          setConfirmRemove(false);
          onClearKey();
        }}
        onClose={() => setConfirmRemove(false)}
      />
    </div>
  );
}
