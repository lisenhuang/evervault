"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Headphones, Loader2, Mic, MicOff, PhoneOff, Volume2 } from "lucide-react";
import type { LiveState } from "./lib/liveSession";
import { formatDuration } from "./lib/time";
import { useT } from "@/i18n/LanguageProvider";

// Symmetric, staggered delays so the bars read as a centered voice wave.
const WAVE_DELAYS = ["-0.4s", "-0.2s", "0s", "-0.2s", "-0.4s"];

/**
 * Inline, non-blocking live-call controls. Docks just above the composer so the chat stays
 * visible and scrollable during a call (the transcript keeps streaming into the message list).
 * The audio orb animates continuously while the call is live so it's obvious you're talking
 * in real time — and doubles as the mute toggle, alongside the dedicated mute button.
 */
export default function CallBar({
  state,
  muted,
  error,
  startedAt,
  echoProne,
  halfDuplex,
  headphones,
  onToggleMute,
  onToggleHeadphones,
  onInterrupt,
  onEnd,
}: {
  state: LiveState;
  muted: boolean;
  error: string;
  /** ms timestamp of when the call connected, or null while still connecting. Drives the live timer. */
  startedAt: number | null;
  /** The model's voice plays without echo cancellation here (iOS speaker / no loopback). */
  echoProne: boolean;
  /** Mic is gated while the model speaks — interrupting is by tap, not by voice. */
  halfDuplex: boolean;
  headphones: boolean;
  onToggleMute: () => void;
  onToggleHeadphones: () => void;
  onInterrupt: () => void;
  onEnd: () => void;
}) {
  const t = useT();
  const STATUS: Record<LiveState, string> = {
    connecting: t.call.connecting,
    listening: t.call.listening,
    speaking: t.call.speaking,
    error: t.call.error,
    closed: t.call.closed,
  };
  const connecting = state === "connecting";
  const errored = state === "error";
  const ended = state === "closed";
  const terminal = errored || ended; // call is over / dead — no live audio, mute is meaningless
  const speaking = state === "speaking";
  // "Live" = audio is actively flowing (listening or speaking) and not muted.
  const live = (speaking || state === "listening") && !muted && !connecting && !terminal;
  // In half-duplex mode voice can't barge in, so while the model speaks the orb becomes the
  // interrupt control instead of a mute toggle (mute stays on its dedicated button). When muted,
  // the orb keeps its unmute role so its label and behavior never diverge.
  const orbInterrupts = halfDuplex && speaking && !muted && !connecting && !terminal;
  const orbLabel = orbInterrupts ? t.call.stopReply : muted ? t.call.unmuteMic : t.call.muteMic;
  const orbTitle = orbInterrupts ? t.call.stopReply : muted ? t.call.unmute : t.call.mute;

  // The orb flips from "stop the reply" back to a mute toggle the instant playback drains. A tap
  // aimed at stopping that lands just after the flip would silently mute the mic — absorb it.
  const prevOrbInterruptsRef = useRef(false);
  const interruptEndedAtRef = useRef(0);
  useEffect(() => {
    if (prevOrbInterruptsRef.current && !orbInterrupts) interruptEndedAtRef.current = Date.now();
    prevOrbInterruptsRef.current = orbInterrupts;
  }, [orbInterrupts]);
  function onOrbTap() {
    if (orbInterrupts) return onInterrupt();
    if (!muted && Date.now() - interruptEndedAtRef.current < 400) return;
    onToggleMute();
  }

  // Tick the elapsed-time display once a second while the call is connected. On cleanup (the call
  // going terminal, or unmount) we snap once more to the real clock, so the frozen readout reflects
  // the true end instant — not a stale last tick — and matches the duration logged to chat history.
  // (The initial 0–1s reads "00:00" because elapsed is clamped to 0 until the first tick.)
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null || terminal) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      clearInterval(id);
      setNowMs(Date.now());
    };
  }, [startedAt, terminal]);
  const elapsed = startedAt != null ? formatDuration((nowMs - startedAt) / 1000) : null;

  return (
    <div className="border-t border-black/10 bg-white/80 backdrop-blur dark:border-white/10 dark:bg-neutral-950/80">
      <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-2.5">
        {/* Animated audio button — pulsing ring + live voice wave, colored by state.
            Tapping it mutes/unmutes the mic — or stops the reply while speaking in half-duplex. */}
        <button
          onClick={onOrbTap}
          disabled={connecting || terminal}
          title={orbTitle}
          aria-label={orbLabel}
          className="relative flex h-12 w-12 shrink-0 items-center justify-center disabled:opacity-50"
        >
          {live && (
            <span
              className={`absolute inline-flex h-12 w-12 animate-ping rounded-full opacity-60 ${
                speaking ? "bg-emerald-500/40" : "bg-blue-500/30"
              }`}
            />
          )}
          <span
            className={`relative flex h-12 w-12 items-center justify-center rounded-full text-white shadow-md transition-transform ${
              muted || terminal
                ? "bg-neutral-400 dark:bg-neutral-600"
                : speaking
                  ? "bg-linear-to-br from-emerald-400 to-teal-500"
                  : "bg-linear-to-br from-blue-500 to-violet-500"
            } ${live ? "scale-105" : ""}`}
          >
            {connecting ? (
              <Loader2 size={20} className="animate-spin" />
            ) : errored ? (
              <AlertTriangle size={20} />
            ) : ended ? (
              <PhoneOff size={20} />
            ) : muted ? (
              <MicOff size={20} />
            ) : live ? (
              <span className="flex h-5 items-center gap-[3px]" aria-hidden="true">
                {WAVE_DELAYS.map((d, i) => (
                  <span
                    key={i}
                    className="block h-4 w-[3px] origin-center animate-wave rounded-full bg-white"
                    style={{ animationDelay: d }}
                  />
                ))}
              </span>
            ) : speaking ? (
              <Volume2 size={20} />
            ) : (
              <Mic size={20} />
            )}
          </span>
        </button>

        {/* Status — announced to assistive tech as the call state changes */}
        <div className="min-w-0 flex-1" role="status" aria-live="polite">
          <p className="flex items-center gap-2 text-sm font-medium text-black dark:text-white">
            <span>{STATUS[state]}</span>
            {/* aria-hidden so the polite live region announces only state changes, not every 1s tick */}
            {elapsed && (
              <span aria-hidden="true" className="font-mono text-xs tabular-nums text-black/50 dark:text-white/50">
                {elapsed}
              </span>
            )}
          </p>
          <p className="truncate text-xs text-black/50 dark:text-white/50">
            {error
              ? error
              : muted
                ? t.call.mutedHint
                : halfDuplex
                  ? speaking
                    ? t.call.gatedSpeakingHint
                    : t.call.gatedHint
                  : t.call.liveHint}
          </p>
        </div>

        {/* Headphones escape hatch — only on echo-prone paths (iOS speaker / no loopback), where
            the mic is gated while the model speaks. Headphones produce no acoustic echo, so
            declaring them lifts the gate and brings voice barge-in back. */}
        {echoProne && (
          <button
            onClick={onToggleHeadphones}
            disabled={connecting || terminal}
            title={headphones ? t.call.headphonesOnTitle : t.call.headphonesOffTitle}
            aria-label={headphones ? t.call.headphonesOnTitle : t.call.headphonesOffTitle}
            aria-pressed={headphones}
            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full shadow-sm transition disabled:opacity-50 ${
              headphones
                ? "bg-neutral-700 text-white hover:bg-neutral-600 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
                : "bg-black/5 text-black hover:bg-black/10 dark:bg-white/10 dark:text-white dark:hover:bg-white/20"
            }`}
          >
            <Headphones size={20} />
          </button>
        )}

        {/* Mute / unmute mic */}
        <button
          onClick={onToggleMute}
          disabled={connecting || terminal}
          title={muted ? t.call.unmute : t.call.mute}
          aria-label={muted ? t.call.unmuteMic : t.call.muteMic}
          aria-pressed={muted}
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full shadow-sm transition disabled:opacity-50 ${
            muted
              ? "bg-neutral-700 text-white hover:bg-neutral-600 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
              : "bg-black/5 text-black hover:bg-black/10 dark:bg-white/10 dark:text-white dark:hover:bg-white/20"
          }`}
        >
          {muted ? <MicOff size={20} /> : <Mic size={20} />}
        </button>

        {/* End call */}
        <button
          onClick={onEnd}
          title={t.call.endCall}
          aria-label={t.call.endCall}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-red-600 text-white shadow-sm transition hover:bg-red-700"
        >
          <PhoneOff size={20} />
        </button>
      </div>
    </div>
  );
}
