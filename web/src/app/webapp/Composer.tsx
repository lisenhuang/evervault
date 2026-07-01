"use client";

import { useRef, useState } from "react";
import { Loader2, Mic, Phone, Send, Square } from "lucide-react";
import { useT } from "@/i18n/LanguageProvider";

export type VoiceState = "idle" | "recording" | "processing";

export default function Composer({
  onSendText,
  onStartVoice,
  onStopVoice,
  onStartCall,
  voiceState,
  disabled,
  hasKey,
  inCall,
  onNeedKey,
}: {
  onSendText: (text: string) => void;
  onStartVoice: () => void;
  onStopVoice: () => void;
  onStartCall: () => void;
  voiceState: VoiceState;
  disabled: boolean;
  hasKey: boolean;
  inCall: boolean;
  onNeedKey: () => void;
}) {
  const t = useT();
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  function grow() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }

  function send() {
    const t = text.trim();
    if (!t || disabled) return;
    if (!hasKey) {
      onNeedKey();
      return;
    }
    onSendText(t);
    setText("");
    requestAnimationFrame(grow);
  }

  function micClick() {
    if (!hasKey) {
      onNeedKey();
      return;
    }
    if (voiceState === "recording") onStopVoice();
    else if (voiceState === "idle") onStartVoice();
  }

  function callClick() {
    if (!hasKey) {
      onNeedKey();
      return;
    }
    onStartCall();
  }

  const recording = voiceState === "recording";
  const processing = voiceState === "processing";

  return (
    <div className="border-t border-black/10 bg-white/80 pb-[env(safe-area-inset-bottom)] backdrop-blur dark:border-white/10 dark:bg-neutral-950/80">
      <div className="mx-auto w-full max-w-3xl px-4 py-3">
        {recording && (
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-red-600 dark:text-red-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-red-600 dark:bg-red-400" />
            {t.composer.recording}
          </div>
        )}
        <div className="flex items-end gap-2">
          <button
            onClick={callClick}
            disabled={disabled || recording || processing || inCall}
            title={inCall ? t.composer.callInProgress : t.composer.startCall}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-emerald-500 to-teal-600 text-white shadow-sm transition hover:opacity-90 disabled:opacity-40"
          >
            <Phone size={18} />
          </button>
          <button
            onClick={micClick}
            disabled={disabled || processing}
            title={recording ? t.composer.stopRecording : t.composer.recordVoice}
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition disabled:opacity-40 ${
              recording
                ? "bg-red-600 text-white hover:bg-red-700"
                : "border border-black/15 hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
            }`}
          >
            {processing ? <Loader2 size={18} className="animate-spin" /> : recording ? <Square size={16} /> : <Mic size={18} />}
          </button>

          <div className="flex flex-1 items-end rounded-2xl border border-black/15 bg-white px-3 py-1.5 dark:border-white/20 dark:bg-neutral-900">
            <textarea
              ref={taRef}
              value={text}
              rows={1}
              disabled={disabled || recording}
              placeholder={recording ? t.composer.listening : t.composer.placeholder}
              onChange={(e) => {
                setText(e.target.value);
                grow();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              className="max-h-40 flex-1 resize-none bg-transparent py-1.5 text-base outline-none md:text-sm disabled:opacity-50"
            />
          </div>

          <button
            onClick={send}
            disabled={disabled || recording || !text.trim()}
            title={t.composer.send}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition hover:bg-blue-700 disabled:opacity-40"
          >
            <Send size={18} />
          </button>
        </div>
        <p className="mt-1.5 text-center text-[11px] text-black/40 dark:text-white/40">
          {t.composer.disclaimer}
        </p>
      </div>
    </div>
  );
}
