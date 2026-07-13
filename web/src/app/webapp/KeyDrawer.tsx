"use client";

import { AudioLines, Cpu, ShieldCheck, X } from "lucide-react";
import VoicePreviewButton from "./VoicePreviewButton";
import VoiceSelect from "./VoiceSelect";
import { useT } from "@/i18n/LanguageProvider";

/**
 * Settings drawer for the keyless /webapp. There's no API key to manage anymore — the backend supplies
 * the Gemini keys — so this holds the one setting the user still controls (the TTS voice) plus a
 * read-only view of the models the admin selected for text, voice, and the live call.
 */
export default function KeyDrawer({
  open,
  onClose,
  textModel,
  audioModel,
  liveModel,
  voice,
  onChangeVoice,
}: {
  open: boolean;
  onClose: () => void;
  textModel: string;
  audioModel: string;
  liveModel: string;
  voice: string;
  onChangeVoice: (v: string) => void;
}) {
  const t = useT();

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
          {/* Managed-by-us note: no key needed on this app. */}
          <div className="flex items-start gap-2.5 rounded-xl border border-emerald-600/20 bg-emerald-50 px-3.5 py-3 text-xs text-emerald-800 dark:border-emerald-400/20 dark:bg-emerald-950/30 dark:text-emerald-200">
            <ShieldCheck size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            <p>{t.settings.managedNote}</p>
          </div>

          {/* Voice */}
          <section>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <AudioLines size={15} aria-hidden="true" /> {t.settings.voice}
            </h3>
            <div className="mt-3">
              <VoiceSelect value={voice} onChange={onChangeVoice} />
              <VoicePreviewButton voice={voice} model={audioModel} />
              <span className="mt-2 block text-xs text-black/45 dark:text-white/45">
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
            </div>
          </section>

          {/* Models (read-only — chosen by the admin for everyone) */}
          <section>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Cpu size={15} aria-hidden="true" /> {t.settings.models}
            </h3>
            <dl className="mt-3 divide-y divide-black/5 overflow-hidden rounded-xl border border-black/10 dark:divide-white/5 dark:border-white/10">
              <ModelRow label={t.settings.textModel} value={textModel} />
              <ModelRow label={t.settings.voiceModel} value={audioModel} />
              <ModelRow label={t.settings.liveModel} value={liveModel} />
            </dl>
          </section>
        </div>
      </aside>
    </div>
  );
}

function ModelRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
      <dt className="text-xs font-medium text-black/60 dark:text-white/60">{label}</dt>
      <dd className="truncate font-mono text-xs text-black/80 dark:text-white/80" title={value}>{value}</dd>
    </div>
  );
}
