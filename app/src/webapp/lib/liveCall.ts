// Realtime voice call, native. Mirrors the web's liveSession + liveAudio, but:
//   • audio runs through react-native-audio-api (Web Audio for RN): AudioRecorder captures 16 kHz PCM,
//     an AudioContext schedules the model's 24 kHz PCM reply gaplessly (like the browser AudioPlayer);
//   • the WebSocket goes to OUR backend relay (/chat/ai/live), which injects a system key — the app
//     sends the exact BidiGenerateContent setup + audio frames the @google/genai SDK would send.
//   • echo is handled by running HALF-DUPLEX: the mic is gated while the model is speaking (unless the
//     user has headphones), so the speaker's sound can't be heard as "user speech". Barge-in is by tap.
//
// NOTE: react-native-audio-api's capture/session API surface can differ across versions; the calls below
// are isolated in MicStreamer / AudioPlayer so they're easy to adjust when running the dev build.

import { AudioContext, AudioManager, AudioRecorder } from "react-native-audio-api";

import { WS_BASE } from "@/config";
import { getToken } from "@/lib/session";
import { MEMORY_PERSONA, RECALL_MEMORY_DECLARATION, runRecallTool } from "./recallTool";
import { currentTimeContext } from "./time";
import { base64ToBytes, bytesToBase64 } from "./wav";

export type LiveState = "connecting" | "listening" | "speaking" | "error" | "closed";

export type LiveCallbacks = {
  onState: (s: LiveState) => void;
  onUserText: (delta: string) => void;
  onModelText: (delta: string) => void;
  onTurnComplete: () => void;
  onError: (msg: string) => void;
};

const SYSTEM_INSTRUCTION =
  "You are EverVault, a warm and concise voice assistant. Keep replies short and natural for a spoken conversation.";

const MIC_RATE = 16000;
const OUT_RATE = 24000;

// --- Gapless PCM16 player (24 kHz), scheduled on an AudioContext timeline like the browser's ---
class AudioPlayer {
  private ctx = new AudioContext({ sampleRate: OUT_RATE });
  private nextStart = 0;
  private live = 0; // scheduled sources still to finish
  onIdle: (() => void) | null = null;

  get isPlaying() {
    return this.nextStart > this.ctx.currentTime + 0.02 || this.live > 0;
  }

  /** True while (or just before) sound is leaving the speaker — the mic-gating signal. */
  get echoRisk() {
    return this.isPlaying;
  }

  async resume() {
    try {
      await this.ctx.resume();
    } catch {
      /* already running */
    }
  }

  enqueue(base64: string) {
    const bytes = base64ToBytes(base64);
    const samples = bytes.length >> 1;
    if (samples === 0) return;
    const buffer = this.ctx.createBuffer(1, samples, OUT_RATE);
    const ch = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < samples; i++) ch[i] = view.getInt16(i * 2, true) / 32768;

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);
    const start = Math.max(this.ctx.currentTime, this.nextStart);
    src.start(start);
    this.nextStart = start + buffer.duration;
    this.live++;
    (src as { onEnded?: () => void }).onEnded = () => {
      this.live = Math.max(0, this.live - 1);
      if (!this.isPlaying) this.onIdle?.();
    };
  }

  /** Barge-in: drop everything queued and reset the timeline. */
  clear() {
    this.nextStart = 0;
    this.live = 0;
  }

  async close() {
    this.clear();
    try {
      await this.ctx.close();
    } catch {
      /* ignore */
    }
  }
}

// --- Mic capture → 16 kHz PCM16 base64 chunks ---
class MicStreamer {
  private recorder: AudioRecorder | null = null;
  private muted = false;

  async start(onChunk: (base64: string) => void) {
    // Configure the audio session for simultaneous play + record (voiceChat enables hardware AEC on iOS).
    try {
      AudioManager.setAudioSessionOptions({
        iosCategory: "playAndRecord",
        iosMode: "voiceChat",
        iosOptions: ["allowBluetoothHFP", "defaultToSpeaker"],
      });
      await AudioManager.setAudioSessionActivity(true);
    } catch {
      /* older API — half-duplex gating still protects against echo */
    }

    const recorder = new AudioRecorder();
    recorder.onAudioReady({ sampleRate: MIC_RATE, bufferLength: 1600, channelCount: 1 }, (event) => {
      if (this.muted) return;
      const floats = event.buffer.getChannelData(0);
      onChunk(bytesToBase64(floatToPcm16(floats)));
    });
    await recorder.start();
    this.recorder = recorder;
  }

  setMuted(m: boolean) {
    this.muted = m;
  }

  stop() {
    try {
      void this.recorder?.stop();
    } catch {
      /* ignore */
    }
    this.recorder = null;
  }
}

function floatToPcm16(floats: Float32Array): Uint8Array {
  const out = new Uint8Array(floats.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < floats.length; i++) {
    const s = Math.max(-1, Math.min(1, floats[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

export class LiveSession {
  private ws?: WebSocket;
  private mic = new MicStreamer();
  private player = new AudioPlayer();
  private cb!: LiveCallbacks;
  private stopped = false;
  private headphones = false;
  private gatedSinceMs: number | null = null;
  private streamEndSent = false;
  private modelTurnActive = false;
  private discardTurnAudio = false;

  constructor(
    private model: string,
    private voice: string,
    private memoryEnabled = false,
    private profileBlock?: string,
    private recentContext?: string,
    private langDirective = "",
  ) {}

  /** Half-duplex here (no browser AEC loopback), so the mic is gated while the model speaks. */
  private get halfDuplex() {
    return !this.headphones;
  }

  setHeadphones(on: boolean) {
    this.headphones = on;
  }

  async start(cb: LiveCallbacks): Promise<void> {
    this.cb = cb;
    cb.onState("connecting");
    await this.player.resume();
    this.player.onIdle = () => {
      if (!this.stopped) cb.onState("listening");
    };

    const token = await getToken();
    const ws = new WebSocket(`${WS_BASE}/chat/ai/live?access_token=${encodeURIComponent(token ?? "")}`);
    this.ws = ws;

    const systemInstruction = [
      this.memoryEnabled && this.profileBlock ? this.profileBlock : "",
      this.memoryEnabled && this.recentContext ? this.recentContext : "",
      this.memoryEnabled ? MEMORY_PERSONA : "",
      SYSTEM_INSTRUCTION,
      this.langDirective,
      currentTimeContext(),
    ]
      .filter(Boolean)
      .join("\n\n");

    ws.onopen = () => {
      // First frame is the BidiGenerateContent setup (minus the key — the relay injects it).
      ws.send(
        JSON.stringify({
          setup: {
            model: this.model.startsWith("models/") ? this.model : `models/${this.model}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
            },
            systemInstruction: { parts: [{ text: systemInstruction }] },
            ...(this.memoryEnabled ? { tools: [{ functionDeclarations: [RECALL_MEMORY_DECLARATION] }] } : {}),
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            realtimeInputConfig: {
              automaticActivityDetection: {
                startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
                endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
                prefixPaddingMs: 300,
                silenceDurationMs: 800,
              },
            },
          },
        }),
      );
    };

    ws.onmessage = (e) => void this.onMessage(e.data);
    ws.onerror = () => {
      if (!this.stopped) {
        cb.onError("Voice connection error.");
        cb.onState("error");
      }
    };
    ws.onclose = () => {
      if (!this.stopped) cb.onState("closed");
    };
  }

  private async beginMic() {
    await this.mic.start((b64) => {
      if (this.halfDuplex && this.player.echoRisk) {
        // Drop mic chunks while the model's voice is sounding (no echo cancellation guarantee).
        if (this.gatedSinceMs == null) this.gatedSinceMs = Date.now();
        else if (!this.streamEndSent && Date.now() - this.gatedSinceMs > 1000) {
          this.send({ realtimeInput: { audioStreamEnd: true } });
          this.streamEndSent = true;
        }
        return;
      }
      this.gatedSinceMs = null;
      this.streamEndSent = false;
      this.send({ realtimeInput: { audio: { data: b64, mimeType: `audio/pcm;rate=${MIC_RATE}` } } });
    });
  }

  private send(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private async onMessage(data: string | ArrayBuffer | Blob) {
    let msg: any;
    try {
      const text = typeof data === "string" ? data : await blobToText(data);
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (msg.error) {
      this.cb.onError(String(msg.error));
      this.cb.onState("error");
      return;
    }

    if (msg.setupComplete) {
      await this.beginMic();
      this.cb.onState("listening");
      return;
    }

    if (msg.toolCall?.functionCalls?.length) {
      const calls = msg.toolCall.functionCalls as { id?: string; name?: string; args?: Record<string, unknown> }[];
      const results = await Promise.all(calls.map((c) => runRecallTool(c.args ?? {})));
      this.send({
        toolResponse: {
          functionResponses: calls.map((c, i) => ({ id: c.id, name: c.name, response: { output: results[i] } })),
        },
      });
      return;
    }

    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.interrupted) {
      this.player.clear();
      this.modelTurnActive = false;
      this.discardTurnAudio = false;
      this.cb.onState("listening");
    }
    for (const p of sc.modelTurn?.parts ?? []) {
      const audio = p.inlineData?.data;
      if (audio && !this.discardTurnAudio) {
        this.player.enqueue(audio);
        this.modelTurnActive = true;
        this.cb.onState("speaking");
      }
    }
    if (sc.inputTranscription?.text) this.cb.onUserText(sc.inputTranscription.text);
    if (sc.outputTranscription?.text && !this.discardTurnAudio) this.cb.onModelText(sc.outputTranscription.text);
    if (sc.turnComplete) {
      this.modelTurnActive = false;
      this.discardTurnAudio = false;
      this.cb.onTurnComplete();
      if (!this.player.isPlaying) this.cb.onState("listening");
    }
  }

  setMuted(m: boolean) {
    this.mic.setMuted(m);
  }

  /** Tap-to-interrupt (half-duplex): stop local playback and swallow the rest of the streaming turn. */
  interrupt() {
    if (!this.modelTurnActive && !this.player.isPlaying) return;
    this.discardTurnAudio = this.modelTurnActive;
    this.player.clear();
    this.cb.onState("listening");
  }

  async stop() {
    this.stopped = true;
    this.mic.stop();
    await this.player.close();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

async function blobToText(data: ArrayBuffer | Blob): Promise<string> {
  if (data instanceof ArrayBuffer) {
    let s = "";
    const bytes = new Uint8Array(data);
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
  // Blob
  return await (data as Blob).text();
}
