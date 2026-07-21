// Realtime audio plumbing for the Live (voice-call) API.
//  - MicStreamer: continuously captures the mic, downsamples to 16 kHz mono PCM16, and emits
//    base64 chunks to stream to Gemini.
//  - AudioPlayer: schedules the 24 kHz PCM16 chunks Gemini streams back so they play gaplessly,
//    and can be cleared instantly for barge-in (when the user interrupts the model).
// All audio stays in the browser — nothing is sent to our server.

import { acquireMicStream } from "./mic";

type AudioCtor = typeof AudioContext;
function makeCtx(): AudioContext {
  const Ctor: AudioCtor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: AudioCtor }).webkitAudioContext;
  return new Ctor();
}

/**
 * iOS / iPadOS (incl. an iPad reporting itself as a Mac). Every browser there is WebKit, where
 * Web Audio output routed through a WebRTC loopback plays back silently — so the echo-cancelling
 * loopback can't be used and we fall back to direct speaker output.
 */
export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/**
 * Best-effort Audio Session hint (Safari-only draft API; no-op elsewhere). The type picks the iOS
 * audio session category WebKit routes the page's audio through:
 *  - "play-and-record": pinned before mic capture to keep iOS on the speaker-friendly call category
 *    for the whole call.
 *  - "playback": media playback (like a music/podcast app) that plays through the hardware Silent
 *    switch — used so a spoken AI reply is audible even when the phone is on silent. Being heard on
 *    silent is the top priority for replies, and only "playback"/"play-and-record" sound through the
 *    switch (the politer "transient-solo"/"ambient" categories are muted by it on iOS). The tradeoff
 *    iOS bundles in: this category interrupts other apps' audio (Spotify, podcasts) while the clip
 *    plays and binds the system Now-Playing transport to us. We restore "auto" the instant the clip
 *    ends — and mark the MediaSession idle (below) — to hand control back as best the platform allows.
 *    Used for spoken AI replies and voice previews.
 *  - "auto": lets WebKit decide; for Web Audio output that lands on an ambient-style category the
 *    Silent switch mutes. Restoring "auto" after a call/clip releases the override, so later media
 *    playback isn't stuck at call volume/routing (WebKit keeps a non-"auto" type as a hard override
 *    for the page's lifetime).
 *
 * Redundant sets are skipped: re-assigning the SAME type still reconfigures the iOS audio session,
 * which can interrupt a currently-playing media element (e.g. the silent loop that keeps reply
 * auto-play unlocked — see unlockAudioPlayback in audio.ts). Only a genuine change is applied.
 */
// Starts as "auto" — the platform default — so a first set to "auto" is already a no-op and can't
// reconfigure (and momentarily interrupt) audio that is just starting.
let currentAudioSessionType: "play-and-record" | "playback" | "auto" = "auto";
export function setAudioSessionType(type: "play-and-record" | "playback" | "auto") {
  if (!isIOS()) return;
  if (type === currentAudioSessionType) return; // already on this category — don't reconfigure
  try {
    const nav = navigator as Navigator & { audioSession?: { type: string } };
    if (nav.audioSession) {
      nav.audioSession.type = type;
      currentAudioSessionType = type;
    }
  } catch {
    /* experimental API — ignore */
  }
  // Best-effort: keep the iOS Now-Playing transport (Control Center / lock screen) in sync so it's
  // released the moment our clip ends. "playback" binds that transport to our audio element, which is
  // why the system play button could replay our clip instead of resuming the other app (e.g. Spotify);
  // marking the MediaSession idle on the way back to "auto" tells iOS we're no longer the active
  // player, giving the other app the best chance to reclaim the controls. Pure metadata hint — no-op
  // where unsupported, and it never affects Silent-switch audibility (that's the audioSession type).
  try {
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = type === "playback" ? "playing" : "none";
    }
  } catch {
    /* experimental API — ignore */
  }
}

// How long past the last scheduled sample the speaker is still considered "sounding": hardware
// output latency plus room decay. Gates the mic in half-duplex mode (see LiveSession).
const ECHO_TAIL_S = 0.3;
// After a manual stop (barge-in / tap-to-interrupt) only the hardware drain remains, so the mic
// can reopen sooner and catch the start of what the user says next.
const CLEAR_TAIL_S = 0.2;

export class MicStreamer {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private processor?: ScriptProcessorNode;
  private source?: MediaStreamAudioSourceNode;
  private muted = false;
  // When capturing (voice-message mode), every 16 kHz mono chunk sent to Gemini is also kept locally so
  // the driver can build the exact same WAV the classic recorder produces — needed for the TTS fallback
  // (if the Live session fails) and for the memory record. Null in call mode (nothing is retained).
  private capture: Float32Array[] | null = null;

  /** Retain every streamed 16 kHz chunk locally so {@link takeCapturedSamples} can rebuild the clip. */
  enableCapture() {
    this.capture = [];
  }

  async start(onChunk: (base64Pcm16: string) => void): Promise<void> {
    setAudioSessionType("play-and-record");
    // Throws a typed MicError (see mic.ts) so startCall can show an accurate mic message.
    this.stream = await acquireMicStream({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = makeCtx();
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    const sink = this.ctx.createGain();
    sink.gain.value = 0; // keep the node alive without echoing the mic to the speakers
    const inRate = this.ctx.sampleRate;

    this.processor.onaudioprocess = (e: AudioProcessingEvent) => {
      if (this.muted) return;
      const down = downsample(e.inputBuffer.getChannelData(0), inRate, 16000);
      // Retain a copy before encoding when capturing (downsample can return the input buffer unchanged,
      // so copy defensively — the ScriptProcessor reuses its buffer between callbacks).
      if (this.capture) this.capture.push(new Float32Array(down));
      onChunk(floatToPcm16Base64(down));
    };
    this.source.connect(this.processor);
    this.processor.connect(sink);
    sink.connect(this.ctx.destination);
  }

  /** The captured 16 kHz mono samples so far (empty if capture wasn't enabled). */
  takeCapturedSamples(): Float32Array[] {
    return this.capture ?? [];
  }

  setMuted(m: boolean) {
    this.muted = m;
  }

  stop() {
    if (this.processor) this.processor.onaudioprocess = null;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    setAudioSessionType("auto");
  }
}

export class AudioPlayer {
  private ctx: AudioContext;
  private dest: MediaStreamAudioDestinationNode;
  private out: AudioNode;
  private nextTime = 0;
  private lastStopAt = 0;
  private sources = new Set<AudioBufferSourceNode>();
  /** Fires when all scheduled output has finished playing (the model stopped speaking). */
  onIdle?: () => void;

  constructor(private sampleRate = 24000) {
    this.ctx = makeCtx();
    // Route output to a MediaStream (not ctx.destination) so it can be played back through a
    // WebRTC loopback — that puts the model's voice on the path the browser's echo canceller
    // references, so it gets removed from the mic. See echoLoopback.ts.
    this.dest = this.ctx.createMediaStreamDestination();
    this.out = this.dest;
  }

  /** The model's output audio as a MediaStream, fed to the echo-cancelling loopback for playback. */
  get stream(): MediaStream {
    return this.dest.stream;
  }

  /**
   * Fallback for when the echo-cancelling loopback can't play (e.g. iOS blocks it): play straight
   * to the speaker so the user still hears the model. Echo cancellation is lost in this mode, but
   * silence is worse. Call before any audio is enqueued.
   */
  useDirectOutput() {
    this.out = this.ctx.destination;
  }

  async resume() {
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  /** Pause playback by suspending the context; scheduled audio resumes from the same spot on resume(). */
  pause() {
    if (this.ctx.state === "running") void this.ctx.suspend();
  }

  enqueue(base64Pcm16: string) {
    const buffer = pcm16ToBuffer(this.ctx, base64Pcm16, this.sampleRate);
    if (!buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.out);
    const start = Math.max(this.ctx.currentTime, this.nextTime);
    src.start(start);
    this.nextTime = start + buffer.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      if (this.sources.size === 0) this.onIdle?.();
    };
  }

  /** Whether audio is (about to be) playing — i.e. there is scheduled output ahead of now. */
  get isPlaying() {
    return this.nextTime > this.ctx.currentTime + 0.02;
  }

  /**
   * True while scheduled output (or its acoustic tail) may still be sounding from the speaker —
   * i.e. an open mic would pick the model's own voice back up. Drives the half-duplex mic gate
   * on platforms whose echo canceller can't remove Web Audio output (see liveSession.ts).
   */
  get echoRisk(): boolean {
    if (this.nextTime === 0 && this.lastStopAt === 0) return false; // nothing has played yet
    return this.ctx.currentTime < Math.max(this.nextTime + ECHO_TAIL_S, this.lastStopAt + CLEAR_TAIL_S);
  }

  /** Barge-in: stop everything currently scheduled. */
  clear() {
    // Only a stop that cut real sound leaves the speaker draining. A clear that arrives after
    // playback already finished must not gate the mic — the user may be mid-sentence by then.
    const hadAudio = this.sources.size > 0 || this.isPlaying;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.nextTime = 0;
    if (hadAudio) this.lastStopAt = this.ctx.currentTime;
  }

  async close() {
    this.clear();
    await this.ctx.close();
  }
}

// --- helpers ---

function downsample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (outRate >= inRate) return input;
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac; // linear interpolation
  }
  return out;
}

function floatToPcm16Base64(samples: Float32Array): string {
  const buf = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bufToBase64(new Uint8Array(buf));
}

function pcm16ToBuffer(ctx: AudioContext, base64: string, sampleRate: number): AudioBuffer | null {
  const bytes = base64ToUint8(base64);
  const samples = Math.floor(bytes.byteLength / 2);
  if (samples === 0) return null;
  const view = new DataView(bytes.buffer);
  const buffer = ctx.createBuffer(1, samples, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < samples; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
  return buffer;
}

function bufToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
