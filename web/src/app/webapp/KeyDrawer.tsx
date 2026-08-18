"use client";

import { AudioLines, Languages, MessageSquare, Mic, PhoneCall, Sparkles, SlidersHorizontal, SunMoon, Trash2, UserRound, X } from "lucide-react";
import VoicePreviewButton from "./VoicePreviewButton";
import VoiceSelect from "./VoiceSelect";
import StyleSelect from "./StyleSelect";
import ThemeToggle from "@/components/theme/ThemeToggle";
import LanguageMenu from "@/i18n/LanguageMenu";
import type { ResponseStyle } from "./lib/responseStyle";
import { useT } from "@/i18n/LanguageProvider";

/**
 * Settings drawer for the keyless /webapp, opened from the account menu. There's no API key to manage
 * anymore — the backend supplies the Gemini keys — so this holds what the user actually controls:
 * language and theme, the TTS voice, and how each surface is answered. Model choices are an admin
 * concern and are deliberately never shown to end users.
 *
 * Language and theme sit here rather than in the sidebar, where they used to live, because the rail's
 * standing space now belongs to the chat history. A scrollable panel is also the only one of the two
 * that can hold them: the account popover they are reached through is `overflow-hidden` and grows
 * upward from the bottom of a full-height column, with nowhere to go once it runs out of room.
 */
export default function KeyDrawer({
  open,
  onClose,
  voice,
  onChangeVoice,
  textStyle,
  voiceStyle,
  liveStyle,
  onChangeTextStyle,
  onChangeVoiceStyle,
  onChangeLiveStyle,
  onDeleteAccount,
}: {
  open: boolean;
  onClose: () => void;
  voice: string;
  onChangeVoice: (v: string) => void;
  textStyle: ResponseStyle;
  voiceStyle: ResponseStyle;
  liveStyle: ResponseStyle;
  onChangeTextStyle: (v: ResponseStyle) => void;
  onChangeVoiceStyle: (v: ResponseStyle) => void;
  onChangeLiveStyle: (v: ResponseStyle) => void;
  /** Start deleting the account. The panel only opens the confirmation; Chat.tsx owns what follows. */
  onDeleteAccount: () => void;
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
          {/* General — the two preferences that used to sit at the foot of the sidebar. First in the
              panel so reaching them never needs a scroll: LanguageMenu closes its own popover on any
              outside scroll, and a language picker you have to scroll to is one you can dismiss by
              accident on the way. */}
          <section>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <SlidersHorizontal size={15} aria-hidden="true" /> {t.settings.general}
            </h3>
            <div className="mt-2 flex items-center justify-between py-1.5">
              <span className="flex items-center gap-3 text-sm font-medium text-black/80 dark:text-white/80">
                <Languages size={18} className="shrink-0" aria-hidden="true" />
                {t.sidebar.language}
              </span>
              <LanguageMenu variant="row" />
            </div>
            <div className="flex items-center justify-between py-1.5">
              <span className="flex items-center gap-3 text-sm font-medium text-black/80 dark:text-white/80">
                <SunMoon size={18} className="shrink-0" aria-hidden="true" />
                {t.sidebar.theme}
              </span>
              <ThemeToggle />
            </div>
          </section>

          {/* Voice */}
          <section>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <AudioLines size={15} aria-hidden="true" /> {t.settings.voice}
            </h3>
            <div className="mt-3">
              <VoiceSelect value={voice} onChange={onChangeVoice} />
              <VoicePreviewButton voice={voice} />
            </div>
          </section>

          {/* Response style — set separately for each surface. Default keeps the built-in tone. */}
          <section>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles size={15} aria-hidden="true" /> {t.settings.responseStyle}
            </h3>
            <p className="mt-1 text-xs text-black/50 dark:text-white/50">{t.settings.responseStyleHint}</p>

            <div className="mt-4 space-y-5">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-black/80 dark:text-white/80">
                  <MessageSquare size={14} aria-hidden="true" /> {t.settings.styleText}
                </div>
                <p className="mt-0.5 text-xs text-black/50 dark:text-white/50">{t.settings.styleTextHint}</p>
                <StyleSelect value={textStyle} onChange={onChangeTextStyle} ariaLabel={t.settings.styleText} />
              </div>

              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-black/80 dark:text-white/80">
                  <Mic size={14} aria-hidden="true" /> {t.settings.styleVoice}
                </div>
                <p className="mt-0.5 text-xs text-black/50 dark:text-white/50">{t.settings.styleVoiceHint}</p>
                <StyleSelect value={voiceStyle} onChange={onChangeVoiceStyle} ariaLabel={t.settings.styleVoice} />
              </div>

              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-black/80 dark:text-white/80">
                  <PhoneCall size={14} aria-hidden="true" /> {t.settings.styleLive}
                </div>
                <p className="mt-0.5 text-xs text-black/50 dark:text-white/50">{t.settings.styleLiveHint}</p>
                <StyleSelect value={liveStyle} onChange={onChangeLiveStyle} ariaLabel={t.settings.styleLive} />
              </div>
            </div>
          </section>

          {/* Account — last, and deliberately quiet. Deleting an account is the most destructive thing
              in this app, but it is also a legitimate thing to want, and red text on a permanent row
              reads as a warning that never stops firing. The confirmation it opens is where the weight
              belongs; here it is just the thing it is. */}
          <section className="border-t border-black/10 pt-5 dark:border-white/10">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <UserRound size={15} aria-hidden="true" /> {t.settings.account}
            </h3>
            <p className="mt-1 text-xs text-black/50 dark:text-white/50">{t.settings.deleteAccountHint}</p>
            <button
              onClick={onDeleteAccount}
              className="mt-3 flex w-full items-center gap-3 rounded-lg border border-black/10 px-3 py-2.5 text-left text-sm font-medium transition hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
            >
              <Trash2 size={16} className="shrink-0 opacity-60" aria-hidden="true" />
              {t.sidebar.deleteAccount}
            </button>
          </section>
        </div>
      </aside>
    </div>
  );
}
