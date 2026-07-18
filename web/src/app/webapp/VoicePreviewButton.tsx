"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Square, Volume2 } from "lucide-react";
import { playAudioUrlHandle } from "./lib/audio";
import { setAudioSessionType } from "./lib/liveAudio";
import { friendlyAiError } from "./lib/aiError";
import { reportAiError } from "./lib/errorReport";
import { useT } from "@/i18n/LanguageProvider";

type Status = "idle" | "loading" | "playing" | "error";

/**
 * Plays the pre-generated per-voice preview sample served by the backend from R2
 * (GET /api/voice-samples/{voice}). No user API key is needed — the backend synthesizes once
 * (server keys, with failover) and caches it in R2, so later plays are instant. Deliberately sends
 * NO model param: the preview always uses the fixed default-model samples (VoiceSampleOptions.Model,
 * pre-generated in /admin/storage), independent of the chat's selected TTS model — so it's always an
 * instant cache hit. Keeps a stoppable handle so it can cancel on re-click, on a voice change, or on
 * unmount.
 */
export default function VoicePreviewButton({ voice }: { voice: string }) {
  const t = useT();
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");

  const mounted = useRef(true);
  const runId = useRef(0); // bumped to invalidate stale async results
  const handleRef = useRef<{ stop: () => void } | null>(null);

  // Tear down any in-flight load + active playback. Safe to call repeatedly.
  function stop() {
    runId.current++;
    if (handleRef.current) {
      handleRef.current.stop();
      handleRef.current = null;
      setAudioSessionType("auto"); // release the iOS Silent-switch bypass taken for this preview
    }
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

  // Stop stale audio when the voice changes — it no longer matches the selection.
  useEffect(() => {
    stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice]);

  async function handleClick() {
    if (status === "playing") {
      stop(); // toggle: a second click stops playback
      return;
    }
    if (!voice) return;

    const id = ++runId.current;
    setError("");
    setStatus("loading");
    try {
      // inline=true makes the API stream the WAV bytes from its own origin instead of 302-redirecting
      // to R2, so we can fetch + decode them via the Web Audio API — which plays reliably on iOS
      // Safari, where a redirecting media element fails with "The operation is not supported".
      // (Must be "true"/"false": the backend binds this to a bool, which rejects "1" with a 400.)
      // No model param: the backend falls back to the default-model sample (the pre-generated one).
      const url = `/api/voice-samples/${encodeURIComponent(voice)}?inline=true`;
      // iOS: play the sample through the "playback" audio session so it's audible even with the
      // hardware Silent switch on (audible-on-silent is the priority; no-op off iOS); released back to
      // "auto" when it ends/stops/errors, which also drops the iOS Now-Playing transport.
      setAudioSessionType("playback");
      const handle = playAudioUrlHandle(url);
      handleRef.current = handle;
      await handle.started; // rejects on load/play error (e.g. 502 all-keys-failed)
      if (!mounted.current || id !== runId.current) return; // stale / cancelled
      setStatus("playing");
      void handle.ended.then(() => {
        if (!mounted.current || id !== runId.current) return;
        handleRef.current = null;
        setAudioSessionType("auto");
        setStatus("idle");
      });
    } catch (e) {
      if (!mounted.current || id !== runId.current) return;
      handleRef.current = null;
      setAudioSessionType("auto");
      setStatus("error");
      // Localized message + reference code, and log the raw detail for admin lookup — never show the
      // backend's raw error text here.
      const fe = friendlyAiError(e, t);
      reportAiError(fe, "voice-sample");
      setError(fe.text);
    }
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={!voice || status === "loading"}
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-black/60 transition hover:bg-black/5 disabled:opacity-50 dark:text-white/60 dark:hover:bg-white/10"
      >
        {status === "loading" ? (
          <>
            <Loader2 size={13} className="animate-spin" /> {t.voicePreview.loading}
          </>
        ) : status === "playing" ? (
          <>
            <Square size={13} /> {t.voicePreview.stop}
          </>
        ) : (
          <>
            <Volume2 size={13} /> {t.voicePreview.preview}
          </>
        )}
      </button>
      {status === "error" && error ? (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : null}
    </div>
  );
}
