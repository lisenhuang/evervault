// Browser audio helpers for voice chat. Recording captures mic input via the Web Audio API and
// encodes 16 kHz mono PCM16 WAV (a format Gemini reliably accepts) as base64. Playback decodes the
// PCM16 that Gemini TTS returns. No audio ever passes through our server.

import { setAudioSessionType } from "./liveAudio";
import { acquireMicStream } from "./mic";

type AudioCtor = typeof AudioContext;
function getAudioContext(): AudioContext {
  const Ctor: AudioCtor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: AudioCtor }).webkitAudioContext;
  return new Ctor();
}

// A single AudioContext shared by every spoken voice-reply clip. iOS starts an AudioContext
// "suspended" and only a USER GESTURE moves it to "running". The old approach — a brand-new context
// per clip, closed when the clip ended — meant an auto-played reply (synthesized a few seconds after
// the tap that triggered it) had no gesture to unlock its fresh context, so it played silently and
// the user had to press "Play" on every reply. Keeping ONE context that stays "running" once unlocked
// lets subsequent replies auto-play without their own tap. (Backgrounding the page suspends it again;
// the next gesture — a "Play" tap or the mic press — re-unlocks it.)
let sharedCtx: AudioContext | null = null;
function sharedAudioContext(): AudioContext {
  if (!sharedCtx || sharedCtx.state === "closed") sharedCtx = getAudioContext();
  return sharedCtx;
}

/**
 * Unlock spoken-reply playback on iOS. Creates (once) and resumes the shared AudioContext. Call it
 * SYNCHRONOUSLY from inside a user gesture (a click/tap/press handler, before any `await`) so iOS
 * grants the unlock; once unlocked the context stays "running", so later voice replies can auto-play
 * without a gesture of their own. Safe to call repeatedly, and a harmless no-op off iOS / when already
 * running. Best-effort: if the platform declines the resume, playback simply falls back to the manual
 * "Play" tap (which unlocks the same context), so no reply is ever left permanently silent.
 */
export function unlockAudioPlayback(): void {
  const ctx = sharedAudioContext();
  if (ctx.state !== "running") void ctx.resume();
}

export type Recorder = {
  stop: () => Promise<{ base64: string; mimeType: string }>;
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
      return { base64: arrayBufferToBase64(wav), mimeType: "audio/wav" };
    },
    cancel() {
      cleanup();
    },
  };
}

/**
 * Play base64 PCM16 (mono) through the shared, gesture-unlocked AudioContext and return a handle to
 * control it. Reusing ONE context (see {@link unlockAudioPlayback}) — rather than a fresh one per clip
 * — is what lets a reply auto-play on iOS: once the context has been resumed inside a gesture (the mic
 * press, or the first "Play" tap), it stays "running", so the next clip can start without its own tap.
 * `ended` resolves when playback finishes naturally OR is stopped (never on pause). `pause()`/`resume()`
 * suspend and continue the context clock, so playback picks back up at the exact same sample.
 *
 * Only one reply clip plays at a time (the caller stops the prior handle before starting a new one), so
 * suspending the whole shared context to pause is safe. The context is deliberately left open when a
 * clip ends — only the source node is torn down — so it stays unlocked for whatever plays next.
 */
export function playPcm16Handle(
  base64: string,
  sampleRate: number,
): { stop: () => void; pause: () => void; resume: () => void; ended: Promise<void> } {
  const bytes = base64ToUint8(base64);
  const samples = Math.floor(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer);
  const ctx = sharedAudioContext();
  // Resume in case this call is the unlocking gesture, or a previous clip left the context suspended
  // (paused). Outside a gesture on a still-locked context this stays pending — the clip then plays once
  // a later gesture unlocks the context, matching the old "first one is silent until you tap" behavior.
  void ctx.resume();
  const buffer = ctx.createBuffer(1, samples, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < samples; i++) channel[i] = view.getInt16(i * 2, true) / 32768;

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);

  let done = false;
  let resolveEnded: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  // Settle exactly once — on natural end OR an explicit stop — and tear down just the source, leaving
  // the shared context open (and unlocked) for the next clip. Resolving here rather than relying on
  // `onended` means a stop() while the context is suspended still settles `ended` immediately.
  const finish = () => {
    if (done) return;
    done = true;
    try {
      src.disconnect();
    } catch {
      /* already disconnected */
    }
    resolveEnded();
  };
  src.onended = finish;
  src.start();

  return {
    stop: () => {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      finish();
    },
    // Suspend/resume the shared context — playback halts and later continues from the exact sample.
    // State-guarded so redundant calls are no-ops, and skipped once the clip has finished.
    pause: () => {
      if (!done && ctx.state === "running") void ctx.suspend();
    },
    resume: () => {
      if (!done && ctx.state === "suspended") void ctx.resume();
    },
    ended,
  };
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
