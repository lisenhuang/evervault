"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Square, Volume2 } from "lucide-react";
import { synthesizeSpeech } from "./lib/gemini";
import { playPcm16Handle } from "./lib/audio";

const SAMPLE_TEXT = "Hi there! This is a quick preview of how this voice sounds.";

type Status = "idle" | "loading" | "playing" | "error";

/**
 * Synthesizes and plays a short sample sentence in the selected voice so users
 * can hear it before committing. Uses the user's own key (browser → Google).
 * Owns a stoppable playback handle so it can cancel on re-click, on a voice/model
 * change, or on unmount — `playPcm16` alone gives no stop handle.
 */
export default function VoicePreviewButton({
  apiKey,
  model,
  voice,
}: {
  apiKey: string;
  model: string;
  voice: string;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");

  const mounted = useRef(true);
  const runId = useRef(0); // bumped to invalidate stale async results
  const handleRef = useRef<{ stop: () => void } | null>(null);

  // Tear down any in-flight synth + active playback. Safe to call repeatedly.
  function stop() {
    runId.current++;
    handleRef.current?.stop();
    handleRef.current = null;
    if (mounted.current) {
      setStatus("idle");
      setError("");
    }
  }

  // Stop on unmount.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stop stale audio when the picker changes — it no longer matches the selection.
  useEffect(() => {
    stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice, model]);

  async function handleClick() {
    if (status === "playing" || status === "loading") {
      stop(); // toggle: a second click cancels
      return;
    }
    if (!apiKey || !model) return;

    const id = ++runId.current;
    setError("");
    setStatus("loading");
    try {
      const { base64, sampleRate } = await synthesizeSpeech(apiKey, model, SAMPLE_TEXT, voice);
      if (!mounted.current || id !== runId.current) return; // stale / cancelled

      const handle = playPcm16Handle(base64, sampleRate);
      handleRef.current = handle;
      setStatus("playing");
      void handle.ended.then(() => {
        if (!mounted.current || id !== runId.current) return;
        handleRef.current = null;
        setStatus("idle");
      });
    } catch (e) {
      if (!mounted.current || id !== runId.current) return;
      setStatus("error");
      setError(e instanceof Error ? e.message : "Could not play the voice sample.");
    }
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={!apiKey || !model || status === "loading"}
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-black/60 transition hover:bg-black/5 disabled:opacity-50 dark:text-white/60 dark:hover:bg-white/10"
      >
        {status === "loading" ? (
          <>
            <Loader2 size={13} className="animate-spin" /> Synthesizing…
          </>
        ) : status === "playing" ? (
          <>
            <Square size={13} /> Stop
          </>
        ) : (
          <>
            <Volume2 size={13} /> Preview voice
          </>
        )}
      </button>
      {status === "error" && error ? (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : null}
    </div>
  );
}
