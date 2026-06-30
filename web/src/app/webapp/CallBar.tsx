"use client";

import { Loader2, Mic, MicOff, PhoneOff, Volume2 } from "lucide-react";
import type { LiveState } from "./lib/liveSession";

const STATUS: Record<LiveState, string> = {
  connecting: "Connecting…",
  listening: "Listening…",
  speaking: "Speaking…",
  error: "Connection problem",
  closed: "Call ended",
};

// Symmetric, staggered delays so the bars read as a centered voice wave.
const WAVE_DELAYS = ["-0.4s", "-0.2s", "0s", "-0.2s", "-0.4s"];

/**
 * Inline, non-blocking live-call controls. Docks just above the composer so the chat stays
 * visible and scrollable during a call (the transcript keeps streaming into the message list).
 * The audio button animates continuously while the call is live so it's obvious you're talking
 * in real time — and doubles as the mute toggle.
 */
export default function CallBar({
  state,
  muted,
  error,
  onToggleMute,
  onEnd,
}: {
  state: LiveState;
  muted: boolean;
  error: string;
  onToggleMute: () => void;
  onEnd: () => void;
}) {
  const connecting = state === "connecting";
  const errored = state === "error";
  const speaking = state === "speaking";
  // "Live" = audio is actively flowing (listening or speaking) and not muted.
  const live = (speaking || state === "listening") && !muted && !connecting && !errored;

  return (
    <div className="border-t border-black/10 bg-white/80 backdrop-blur dark:border-white/10 dark:bg-neutral-950/80">
      <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-2.5">
        {/* Animated audio button — pulsing ring + live voice wave, colored by state.
            Tapping it mutes/unmutes the mic. */}
        <button
          onClick={onToggleMute}
          disabled={connecting || errored}
          title={muted ? "Unmute" : "Mute"}
          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
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
              muted
                ? "bg-neutral-400 dark:bg-neutral-600"
                : speaking
                  ? "bg-linear-to-br from-emerald-400 to-teal-500"
                  : "bg-linear-to-br from-blue-500 to-violet-500"
            } ${live ? "scale-105" : ""}`}
          >
            {connecting ? (
              <Loader2 size={20} className="animate-spin" />
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

        {/* Status */}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-black dark:text-white">{STATUS[state]}</p>
          <p className="truncate text-xs text-black/50 dark:text-white/50">
            {error
              ? error
              : muted
                ? "Your mic is muted — tap the orb to unmute"
                : "Just talk — I’ll answer out loud. Speak any time to interrupt."}
          </p>
        </div>

        {/* End call */}
        <button
          onClick={onEnd}
          title="End call"
          aria-label="End call"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-red-600 text-white shadow-sm transition hover:bg-red-700"
        >
          <PhoneOff size={20} />
        </button>
      </div>
    </div>
  );
}
