// Browser audio helpers for voice chat. Recording captures mic input via the Web Audio API and
// encodes 16 kHz mono PCM16 WAV (a format Gemini reliably accepts) as base64. Reply playback wraps
// the PCM16 that Gemini TTS returns in a WAV header and plays it through a persistent HTMLAudioElement
// (see below). No audio ever passes through our server.

import { setAudioSessionType } from "./liveAudio";
import { acquireMicStream } from "./mic";

type AudioCtor = typeof AudioContext;
function getAudioContext(): AudioContext {
  const Ctor: AudioCtor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: AudioCtor }).webkitAudioContext;
  return new Ctor();
}

// Voice replies play through ONE persistent HTMLAudioElement rather than the Web Audio API. Media
// elements are the playback path iOS treats as first-class: they renegotiate the output route on
// every play() (so they survive the device reconfiguration that microphone capture causes — a Web
// Audio context from before/around a capture session can come out of it silently broken), and they
// are categorized as media playback, sounding through the hardware Silent switch. Reusing one element
// also carries iOS's play permission across clips: an element that has ever played inside a user
// gesture may be replayed programmatically later, which is what lets a reply auto-play seconds after
// the tap that triggered it (see unlockAudioPlayback).
let replyEl: HTMLAudioElement | null = null;
// The blob URL of the clip currently loaded into the element; null when the element is free. Guards
// re-priming from clobbering an in-flight clip, and lets a stale handle detect it no longer owns the
// element.
let replyClipUrl: string | null = null;

function replyAudioElement(): HTMLAudioElement {
  if (!replyEl) {
    replyEl = new Audio();
    replyEl.preload = "auto";
  }
  return replyEl;
}

// A tiny (10 ms) silent WAV used to prime the reply element inside a user gesture — audible playback
// permission is granted to the element without the user hearing anything. Built lazily, reusing the
// recorder's WAV encoder.
let silentWavUri: string | null = null;
function silentWav(): string {
  if (!silentWavUri) {
    silentWavUri = `data:audio/wav;base64,${arrayBufferToBase64(encodeWav(new Float32Array(160), 16000))}`;
  }
  return silentWavUri;
}

// Backstop for the priming loop below: if no reply ever claims the element (the generation failed in
// some path that forgot to release, or the tab sat idle), stop looping silence rather than playing it
// forever. Generously above the reply pipeline's worst case (~75 s of polling plus synthesis time).
const PRIME_LOOP_CAP_MS = 100_000;
let primeCapTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Keep spoken-reply playback unlocked on iOS by LOOPING a silent clip through the persistent reply
 * element. Call it SYNCHRONOUSLY from inside a user gesture (a click/tap handler, before any `await`).
 *
 * A one-shot silent prime is not enough: the mic press / stop tap immediately reconfigures the audio
 * session for capture, which can abort the 10 ms clip before it ever reaches "playing" — and iOS only
 * grants an element durable play permission once playback has actually begun inside the gesture.
 * Looping keeps the element *actively playing* (inaudibly) from the tap until the reply arrives;
 * swapping a new src into an already-playing element and calling play() is allowed without a fresh
 * gesture, so the reply auto-plays (see playPcm16Handle, which claims the element and ends the loop).
 *
 * Safe to call repeatedly (re-kicks the loop if capture churn paused it); a no-op while a real clip
 * owns the element. Callers on paths where no reply will arrive must call releaseAudioPlayback() so
 * the loop doesn't idle on; the cap timer is the backstop for anything missed. Best-effort: if the
 * platform still declines the later auto-play, the reply's "Play" button plays the same element
 * directly inside its own tap, so no reply is ever left unplayable.
 */
export function unlockAudioPlayback(): void {
  if (replyClipUrl) return; // a clip is loaded/playing — don't replace its src
  const el = replyAudioElement();
  // Reassigning src reloads the element, so only do it when it isn't already on the silent clip (or
  // needs the reload to clear an error) — repeated unlock calls then just re-kick play() on the loop.
  if (el.src !== silentWav() || el.error) el.src = silentWav();
  el.loop = true;
  const p = el.play();
  if (p) p.catch(() => {/* priming denied — the Play button remains the unlock path */});
  clearTimeout(primeCapTimer);
  primeCapTimer = setTimeout(releaseAudioPlayback, PRIME_LOOP_CAP_MS);
}

/**
 * Stop the silent priming loop (see {@link unlockAudioPlayback}) once it's known no reply will claim
 * the element: the recording failed or was discarded, the reply errored out or arrived without audio,
 * or it landed while the tab was hidden (where auto-play is skipped anyway). No-op while a real clip
 * owns the element — a claimed clip's own lifecycle releases it.
 */
export function releaseAudioPlayback(): void {
  if (replyClipUrl) return;
  clearTimeout(primeCapTimer);
  if (replyEl) {
    replyEl.loop = false;
    replyEl.pause();
  }
}

export type Recorder = {
  /** `seconds` is the captured duration — callers gate on it so a blink-quick tap-tap isn't sent. */
  stop: () => Promise<{ base64: string; mimeType: string; seconds: number }>;
  cancel: () => void;
};

export async function startRecording(): Promise<Recorder> {
  // iOS: pin the record-friendly audio session BEFORE acquiring the mic (mirrors MicStreamer.start).
  // unlockAudioPlayback() and any just-played reply leave the session on a playback category; on iOS
  // getUserMedia can then fail with no prompt unless we switch it to "play-and-record" first. No-op
  // off iOS. Released back to "auto" if acquisition fails, and on cleanup once recording ends.
  setAudioSessionType("play-and-record");
  let stream: MediaStream;
  try {
    // acquireMicStream throws a typed MicError (unsupported / insecure / denied / notfound / inuse)
    // so the caller can show an accurate message instead of a blanket "access was blocked".
    stream = await acquireMicStream({ audio: true });
  } catch (e) {
    setAudioSessionType("auto"); // release the record session we optimistically pinned
    throw e;
  }
  const ctx = getAudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0; // keep the processor running without echoing mic to speakers

  const chunks: Float32Array[] = [];
  processor.onaudioprocess = (e: AudioProcessingEvent) => {
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  processor.connect(mute);
  mute.connect(ctx.destination);

  const inRate = ctx.sampleRate;
  const cleanup = () => {
    processor.onaudioprocess = null;
    processor.disconnect();
    mute.disconnect();
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
    setAudioSessionType("auto"); // release the record session so a later reply plays back normally
  };

  return {
    async stop() {
      const merged = mergeFloat32(chunks);
      cleanup();
      const down = downsample(merged, inRate, 16000);
      const wav = encodeWav(down, 16000);
      return { base64: arrayBufferToBase64(wav), mimeType: "audio/wav", seconds: down.length / 16000 };
    },
    cancel() {
      cleanup();
    },
  };
}

/**
 * Play base64 PCM16 (mono) as a voice reply through the persistent, gesture-primed reply element
 * (see {@link unlockAudioPlayback}) and return a handle to control it. The PCM16 is wrapped in a WAV
 * header (no re-encoding) and handed to the element as a blob URL — the element renegotiates the
 * output route per play(), which is what makes replies audible again right after microphone capture,
 * where a Web Audio context would come out silently broken.
 *
 * `ended` resolves when playback finishes naturally, is stopped, or fails to start (never on pause) —
 * a failed auto-play (e.g. the element was never primed after a page reload) settles immediately, so
 * the bubble falls back to its normal "Play" button, whose tap plays this same element inside a
 * gesture. `pause()`/`resume()` map to the element's native pause/play, which keep position exactly.
 * Only one reply clip plays at a time (the caller stops the prior handle before starting a new one).
 */
export function playPcm16Handle(
  base64: string,
  sampleRate: number,
): { stop: () => void; pause: () => void; resume: () => void; ended: Promise<void> } {
  const el = replyAudioElement();
  const url = URL.createObjectURL(pcm16ToWavBlob(base64ToUint8(base64), sampleRate));
  // Claim the element: end the silent priming loop (the element is ideally still playing it — that's
  // what lets this src swap + play() proceed without a fresh gesture) and take ownership.
  clearTimeout(primeCapTimer);
  el.loop = false;
  replyClipUrl = url;

  let done = false;
  let resolveEnded: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  // This handle owns the element only while its own blob URL is loaded; a newer clip that replaced
  // the src (the caller stops the old handle first, but late events can still race) must not have the
  // element paused or its state clobbered from under it by a stale handle.
  const ownsElement = () => el.currentSrc === url || el.src === url;
  // Settle exactly once — natural end, stop(), or a start failure — then release the element and the
  // blob URL. The element itself stays alive (and gesture-primed) for the next clip.
  const finish = () => {
    if (done) return;
    done = true;
    if (ownsElement()) {
      el.pause();
      el.onended = null;
      el.onerror = null;
      replyClipUrl = null;
    }
    URL.revokeObjectURL(url);
    resolveEnded();
  };

  el.onended = finish;
  el.onerror = finish;
  el.src = url;
  const p = el.play();
  // A rejected play (not primed / platform veto) settles `ended` right away: the caller's playing
  // state clears and the bubble's "Play" button becomes the gesture that retries this clip fresh.
  if (p) p.catch(finish);

  return {
    stop: finish,
    // Native element pause/resume — position is kept by the element, so resume continues exactly
    // where pause left off. Guarded so calls after finish (or from a stale handle) are no-ops.
    pause: () => {
      if (!done && ownsElement()) el.pause();
    },
    resume: () => {
      if (!done && ownsElement()) {
        const rp = el.play();
        if (rp) rp.catch(() => {/* resume declined — stays paused; the next tap retries */});
      }
    },
    ended,
  };
}

// Wrap little-endian PCM16 bytes in a 44-byte WAV header (mono). No re-encoding — the payload is
// used as-is, matching the header the recorder writes in encodeWav.
function pcm16ToWavBlob(pcmBytes: Uint8Array, sampleRate: number): Blob {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + pcmBytes.byteLength, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, pcmBytes.byteLength, true);
  return new Blob([header, pcmBytes as BlobPart], { type: "audio/wav" });
}

/**
 * Plays an audio file from a URL via HTMLAudioElement (which follows a cross-origin redirect — e.g.
 * our /api/voice-samples/{voice} → presigned R2 — without needing CORS, unlike fetch). Returns:
 *  - `started`: resolves when playback actually begins; REJECTS on load/play error.
 *  - `ended`: resolves when playback ends, is stopped, or errors.
 *  - `stop()`: halts playback and settles both promises.
 */
export function playUrlHandle(url: string): {
  stop: () => void;
  started: Promise<void>;
  ended: Promise<void>;
} {
  const el = new Audio(url);
  let onStarted: () => void = () => {};
  let onStartFail: (e: unknown) => void = () => {};
  let onEnded: () => void = () => {};
  const started = new Promise<void>((resolve, reject) => {
    onStarted = resolve;
    onStartFail = reject;
  });
  const ended = new Promise<void>((resolve) => {
    onEnded = resolve;
  });
  el.onplaying = () => onStarted();
  el.onended = () => onEnded();
  el.onerror = () => {
    onStartFail(new Error("Could not play the voice sample."));
    onEnded();
  };
  void el.play().catch((e) => {
    onStartFail(e);
    onEnded();
  });
  return {
    stop: () => {
      try {
        el.pause();
        el.currentTime = 0;
      } catch {
        /* ignore */
      }
      onStarted(); // no-op if already settled — unblocks a still-awaiting caller
      onEnded();
    },
    started,
    ended,
  };
}

/**
 * Fetches an audio file from a SAME-ORIGIN url and plays it through the Web Audio API. Unlike
 * {@link playUrlHandle} (which hands the url to an HTMLAudioElement), this sidesteps the iOS Safari
 * "The operation is not supported" failure that a media element hits when its source 302-redirects
 * cross-origin (e.g. our endpoint → presigned R2): the AudioContext is created synchronously inside
 * the click gesture — so iOS lets it play — and we fetch + decode the bytes ourselves. The url MUST
 * return the audio bytes directly (no cross-origin redirect), so the fetch isn't blocked by CORS.
 *  - `started`: resolves when playback begins; REJECTS on fetch/decode error.
 *  - `ended`: resolves when playback ends, is stopped, or errors.
 *  - `stop()`: halts playback and settles both promises.
 */
export function playAudioUrlHandle(url: string): {
  stop: () => void;
  started: Promise<void>;
  ended: Promise<void>;
} {
  // Create + resume the context synchronously within the user gesture so iOS unlocks playback.
  const ctx = getAudioContext();
  void ctx.resume();

  let src: AudioBufferSourceNode | null = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    void ctx.close();
  };

  let onStarted: () => void = () => {};
  let onStartFail: (e: unknown) => void = () => {};
  let onEnded: () => void = () => {};
  const started = new Promise<void>((resolve, reject) => {
    onStarted = resolve;
    onStartFail = reject;
  });
  const ended = new Promise<void>((resolve) => {
    onEnded = resolve;
  });

  void (async () => {
    try {
      const res = await fetch(url, { credentials: "same-origin" });
      if (!res.ok) {
        // Throw the raw body (it carries { error, referenceCode }) + status so the caller's
        // friendlyAiError can localize the message and surface the backend's reference code.
        const body = await res.text().catch(() => "");
        throw Object.assign(new Error(body || `HTTP ${res.status}`), { status: res.status });
      }
      const bytes = await res.arrayBuffer();
      const buffer = await ctx.decodeAudioData(bytes);
      if (closed) return; // stopped while it was still loading
      src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.onended = () => {
        close();
        onEnded();
      };
      src.start();
      onStarted();
    } catch (e) {
      onStartFail(e);
      close();
      onEnded();
    }
  })();

  return {
    stop: () => {
      if (src) {
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
      }
      close();
      onStarted(); // no-op if already settled — unblocks a still-awaiting caller
      onEnded();
    },
    started,
    ended,
  };
}

// --- encoding helpers ---

function mergeFloat32(chunks: Float32Array[]): Float32Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Float32Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function downsample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (outRate >= inRate) return input;
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = input[Math.floor(i * ratio)];
  return out;
}

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return buffer;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
