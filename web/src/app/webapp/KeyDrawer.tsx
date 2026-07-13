"use client";

import { AudioLines, ShieldCheck, X } from "lucide-react";
import VoicePreviewButton from "./VoicePreviewButton";
import VoiceSelect from "./VoiceSelect";
import { useT } from "@/i18n/LanguageProvider";

/**
 * Settings drawer for the keyless /webapp. There's no API key to manage anymore — the backend supplies
 * the Gemini keys — so this holds the one setting the user still controls: the TTS voice. The model
 * choices are an admin concern and aren't shown here. (textModel/liveModel are still accepted so the
 * caller's props don't need to change, but only the voice model drives the preview.)
 */
export default function KeyDrawer({
  open,
  onClose,
  audioModel,
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
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}
