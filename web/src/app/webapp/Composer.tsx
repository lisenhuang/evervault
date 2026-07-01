"use client";

import { useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, Mic, Phone, Send, Square, X } from "lucide-react";
import { useT } from "@/i18n/LanguageProvider";
import { isAcceptedImage, prepareImage, type PreparedImage } from "./lib/image";

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
  onSendText: (text: string, image?: PreparedImage) => void;
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
  const [focused, setFocused] = useState(false);
  // One image per message: attaching (via the button or paste) replaces any previous attachment.
  const [image, setImage] = useState<PreparedImage | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  // On touch devices (phones/tablets) Enter should insert a newline like a
  // messaging app; the send button is used to send. On desktop, Enter sends.
  const [isTouch, setIsTouch] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(hover: none) and (pointer: coarse)");
    const update = () => setIsTouch(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  function grow() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }

  function send() {
    const trimmed = text.trim();
    if ((!trimmed && !image) || disabled || imageBusy) return;
    if (!hasKey) {
      onNeedKey();
      return;
    }
    onSendText(trimmed, image ?? undefined);
    setText("");
    setImage(null);
    requestAnimationFrame(grow);
  }

  async function attach(file: File) {
    if (!isAcceptedImage(file)) return;
    setImageBusy(true);
    try {
      setImage(await prepareImage(file));
    } catch {
      // Unreadable file: keep the composer usable; the user can try another image.
    } finally {
      setImageBusy(false);
    }
  }

  function attachClick() {
    if (!hasKey) {
      onNeedKey();
      return;
    }
    fileRef.current?.click();
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
        {(image || imageBusy) && (
          <div className="mb-2 flex items-start">
            <div className="relative">
              {image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={image.dataUrl}
                  alt={t.composer.attachedImage}
                  className="h-20 w-20 rounded-xl border border-black/10 object-cover shadow-sm dark:border-white/15"
                />
              ) : (
                <div className="flex h-20 w-20 items-center justify-center rounded-xl border border-black/10 bg-black/5 dark:border-white/15 dark:bg-white/10">
                  <Loader2 size={18} className="animate-spin text-black/40 dark:text-white/40" />
                </div>
              )}
              {image && (
                <button
                  onClick={() => setImage(null)}
                  title={t.composer.removeImage}
                  aria-label={t.composer.removeImage}
                  className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-white shadow-sm transition hover:bg-black dark:bg-white/80 dark:text-black dark:hover:bg-white"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>
        )}
        <div className="flex items-end gap-2">
          <button
            onClick={callClick}
            disabled={disabled || recording || processing || inCall}
            title={inCall ? t.composer.callInProgress : t.composer.startCall}
            className={`${focused ? "hidden md:flex" : "flex"} h-11 w-11 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-emerald-500 to-teal-600 text-white shadow-sm transition hover:opacity-90 disabled:opacity-40`}
          >
            <Phone size={18} />
          </button>
          <button
            onClick={micClick}
            disabled={disabled || processing}
            title={recording ? t.composer.stopRecording : t.composer.recordVoice}
            className={`${focused ? "hidden md:flex" : "flex"} h-11 w-11 shrink-0 items-center justify-center rounded-full transition disabled:opacity-40 ${
              recording
                ? "bg-red-600 text-white hover:bg-red-700"
                : "border border-black/15 hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
            }`}
          >
            {processing ? <Loader2 size={18} className="animate-spin" /> : recording ? <Square size={16} /> : <Mic size={18} />}
          </button>

          <div className="flex flex-1 items-end rounded-2xl border border-black/15 bg-white px-2 py-1.5 dark:border-white/20 dark:bg-neutral-900">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = ""; // allow re-picking the same file
                if (f) void attach(f);
              }}
            />
            <button
              onClick={attachClick}
              disabled={disabled || recording || imageBusy}
              title={t.composer.attachImage}
              aria-label={t.composer.attachImage}
              className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-black/50 transition hover:bg-black/5 disabled:opacity-40 dark:text-white/50 dark:hover:bg-white/10"
            >
              <ImagePlus size={18} />
            </button>
            <textarea
              ref={taRef}
              value={text}
              rows={1}
              disabled={disabled || recording}
              placeholder={recording ? t.composer.listening : t.composer.placeholder}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onChange={(e) => {
                setText(e.target.value);
                grow();
              }}
              onPaste={(e) => {
                const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
                const f = item?.getAsFile();
                if (f) {
                  e.preventDefault();
                  void attach(f);
                }
              }}
              onKeyDown={(e) => {
                // On touch devices, let Enter insert a newline (default behavior).
                if (e.key === "Enter" && !e.shiftKey && !isTouch) {
                  e.preventDefault();
                  send();
                }
              }}
              className="max-h-40 flex-1 resize-none bg-transparent px-1 py-1.5 text-base outline-none md:text-sm disabled:opacity-50"
            />
          </div>

          <button
            onClick={send}
            disabled={disabled || recording || imageBusy || (!text.trim() && !image)}
            title={t.composer.send}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition hover:bg-blue-700 disabled:opacity-40"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
