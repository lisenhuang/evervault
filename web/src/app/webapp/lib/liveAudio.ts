// Realtime audio plumbing for the Live (voice-call) API.
//  - MicStreamer: continuously captures the mic, downsamples to 16 kHz mono PCM16, and emits
//    base64 chunks to stream to Gemini.
//  - AudioPlayer: schedules the 24 kHz PCM16 chunks Gemini streams back so they play gaplessly,
//    and can be cleared instantly for barge-in (when the user interrupts the model).
// All audio stays in the browser — nothing is sent to our server.

type AudioCtor = typeof AudioContext;
function makeCtx(): AudioContext {
  const Ctor: AudioCtor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: AudioCtor }).webkitAudioContext;
  return new Ctor();
}

export class MicStreamer {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private processor?: ScriptProcessorNode;
  private source?: MediaStreamAudioSourceNode;
  private muted = false;

  async start(onChunk: (base64Pcm16: string) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
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
      onChunk(floatToPcm16Base64(down));
    };
    this.source.connect(this.processor);
    this.processor.connect(sink);
    sink.connect(this.ctx.destination);
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
  }
}

export class AudioPlayer {
  private ctx: AudioContext;
  private dest: MediaStreamAudioDestinationNode;
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  /** Fires when all scheduled output has finished playing (the model stopped speaking). */
  onIdle?: () => void;

  constructor(private sampleRate = 24000) {
    this.ctx = makeCtx();
    // Route output to a MediaStream (not ctx.destination) so it can be played back through a
    // WebRTC loopback — that puts the model's voice on the path the browser's echo canceller
    // references, so it gets removed from the mic. See echoLoopback.ts.
    this.dest = this.ctx.createMediaStreamDestination();
  }

  /** The model's output audio as a MediaStream, fed to the echo-cancelling loopback for playback. */
  get stream(): MediaStream {
    return this.dest.stream;
  }

  async resume() {
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  enqueue(base64Pcm16: string) {
    const buffer = pcm16ToBuffer(this.ctx, base64Pcm16, this.sampleRate);
    if (!buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.dest);
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

  /** Barge-in: stop everything currently scheduled. */
  clear() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.nextTime = 0;
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
