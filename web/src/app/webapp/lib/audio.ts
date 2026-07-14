// Browser audio helpers for voice chat. Recording captures mic input via the Web Audio API and
// encodes 16 kHz mono PCM16 WAV (a format Gemini reliably accepts) as base64. Playback decodes the
// PCM16 that Gemini TTS returns. No audio ever passes through our server.

type AudioCtor = typeof AudioContext;
function getAudioContext(): AudioContext {
  const Ctor: AudioCtor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: AudioCtor }).webkitAudioContext;
  return new Ctor();
}

export type Recorder = {
  stop: () => Promise<{ base64: string; mimeType: string }>;
  cancel: () => void;
};

export async function startRecording(): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
 * Play base64 PCM16 (mono) and return a handle to control it. `ended` resolves when playback
 * finishes naturally OR is stopped (never on pause). `pause()`/`resume()` halt and continue the
 * context clock, so playback picks back up at the exact same sample. Start from a user gesture;
 * resume() is also gesture-driven (a click), so it's allowed even under iOS autoplay policy.
 */
export function playPcm16Handle(
  base64: string,
  sampleRate: number,
): { stop: () => void; pause: () => void; resume: () => void; ended: Promise<void> } {
  const bytes = base64ToUint8(base64);
  const samples = Math.floor(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer);
  const ctx = getAudioContext();
  const buffer = ctx.createBuffer(1, samples, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < samples; i++) channel[i] = view.getInt16(i * 2, true) / 32768;

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    void ctx.close();
  };
  const ended = new Promise<void>((resolve) => {
    src.onended = () => {
      close();
      resolve();
    };
    src.start();
  });
  return {
    stop: () => {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      close();
    },
    // Suspend/resume the whole context — playback halts and later continues from the exact sample.
    // Safe to call redundantly (state-guarded); no-op once the clip has ended and closed the context.
    pause: () => {
      if (!closed && ctx.state === "running") void ctx.suspend();
    },
    resume: () => {
      if (!closed && ctx.state === "suspended") void ctx.resume();
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
