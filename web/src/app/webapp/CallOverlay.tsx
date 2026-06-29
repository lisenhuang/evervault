"use client";

import { Loader2, Mic, MicOff, PhoneOff } from "lucide-react";
import type { LiveState } from "./lib/liveSession";

const STATUS: Record<LiveState, string> = {
  connecting: "Connecting…",
  listening: "Listening…",
  speaking: "Speaking…",
  error: "Connection problem",
  closed: "Call ended",
};

export default function CallOverlay({
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
  const speaking = state === "speaking";
  const listening = state === "listening" && !muted;

  return (
    <div className="fixed inset-0 z-40 flex flex-col items-center justify-center bg-neutral-950/80 backdrop-blur-md">
      <div className="flex flex-col items-center gap-8 px-6 text-center text-white">
        {/* Animated orb */}
        <div className="relative flex h-44 w-44 items-center justify-center">
          {(speaking || listening) && (
            <span
              className={`absolute inline-flex h-full w-full rounded-full opacity-60 ${
                speaking ? "animate-ping bg-emerald-500/40" : "animate-ping bg-blue-500/30"
              }`}
            />
          )}
          <span
            className={`absolute h-32 w-32 rounded-full blur-2xl transition-colors ${
              speaking ? "bg-emerald-500/50" : muted ? "bg-white/10" : "bg-blue-500/40"
            }`}
          />
          <div
            className={`relative flex h-28 w-28 items-center justify-center rounded-full bg-linear-to-br shadow-2xl transition-transform ${
              speaking ? "scale-110 from-emerald-400 to-teal-500" : "from-blue-500 to-violet-500"
            }`}
          >
            <span className="text-4xl">{speaking ? "🔊" : "🎙️"}</span>
          </div>
        </div>

        <div className="space-y-1">
          <p className="text-lg font-medium">
            {state === "connecting" && <Loader2 size={16} className="mr-2 inline animate-spin" />}
            {STATUS[state]}
          </p>
          <p className="text-sm text-white/55">
            {error
              ? error
              : muted
                ? "Your mic is muted"
                : "Just talk — I’ll answer out loud. Speak any time to interrupt."}
          </p>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-5">
          <button
            onClick={onToggleMute}
            disabled={state === "connecting" || state === "error"}
            title={muted ? "Unmute" : "Mute"}
            className={`flex h-14 w-14 items-center justify-center rounded-full transition disabled:opacity-40 ${
              muted ? "bg-white text-neutral-900 hover:bg-white/90" : "bg-white/15 text-white hover:bg-white/25"
            }`}
          >
            {muted ? <MicOff size={22} /> : <Mic size={22} />}
          </button>
          <button
            onClick={onEnd}
            title="End call"
            className="flex h-16 w-16 items-center justify-center rounded-full bg-red-600 text-white shadow-lg transition hover:bg-red-700"
          >
            <PhoneOff size={26} />
          </button>
        </div>
      </div>
    </div>
  );
}
