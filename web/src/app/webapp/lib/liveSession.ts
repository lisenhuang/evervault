// Realtime voice call backed by the Gemini Live API. Streams mic audio up and the model's spoken
// reply down over a WebSocket — hands-free, with server-side voice-activity detection (no push-to-
// talk) and barge-in (interrupt the model by speaking). Uses the user's own key, browser → Google.

import { GoogleGenAI, Modality, StartSensitivity, EndSensitivity, type LiveServerMessage } from "@google/genai";
import { AudioPlayer, MicStreamer } from "./liveAudio";
import { EchoLoopback } from "./echoLoopback";

export type LiveState = "connecting" | "listening" | "speaking" | "error" | "closed";

export type LiveCallbacks = {
  onState: (s: LiveState) => void;
  onUserText: (delta: string) => void;
  onModelText: (delta: string) => void;
  onTurnComplete: () => void;
  onError: (msg: string) => void;
};

type SessionHandle = Awaited<ReturnType<GoogleGenAI["live"]["connect"]>>;

const SYSTEM_INSTRUCTION =
  "You are EverVault, a warm and concise voice assistant. Keep replies short and natural for a spoken conversation.";

export class LiveSession {
  private session?: SessionHandle;
  private mic = new MicStreamer();
  private player = new AudioPlayer();
  private loopback = new EchoLoopback();
  private cb!: LiveCallbacks;
  private stopped = false;

  constructor(
    private apiKey: string,
    private model: string,
    private voice: string,
  ) {}

  async start(cb: LiveCallbacks): Promise<void> {
    this.cb = cb;
    cb.onState("connecting");
    await this.player.resume();
    // Play the model's voice through a WebRTC loopback so the browser's echo canceller removes
    // it from the mic (fixes the model interrupting itself off the phone speaker; see echoLoopback.ts).
    await this.loopback.start(this.player.stream);
    this.player.onIdle = () => {
      if (!this.stopped) cb.onState("listening");
    };

    const ai = new GoogleGenAI({ apiKey: this.apiKey });
    this.session = await ai.live.connect({
      model: this.model,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: SYSTEM_INSTRUCTION,
        // Make voice-activity detection less twitchy so any residual speaker echo doesn't get
        // mistaken for the user speaking. Genuine speech still interrupts (barge-in stays on).
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
            prefixPaddingMs: 300,
            silenceDurationMs: 800,
          },
        },
      },
      callbacks: {
        onopen: () => {},
        onmessage: (m: LiveServerMessage) => this.onMessage(m),
        onerror: (e: ErrorEvent) => {
          cb.onError(e.message || "Voice connection error.");
          cb.onState("error");
        },
        onclose: () => {
          if (!this.stopped) cb.onState("closed");
        },
      },
    });

    await this.mic.start((b64) => {
      this.session?.sendRealtimeInput({ audio: { data: b64, mimeType: "audio/pcm;rate=16000" } });
    });
    cb.onState("listening");
  }

  private onMessage(m: LiveServerMessage) {
    const sc = m.serverContent;
    if (sc?.interrupted) {
      this.player.clear(); // barge-in: drop whatever the model was saying
      this.cb.onState("listening");
    }
    for (const p of sc?.modelTurn?.parts ?? []) {
      const data = p.inlineData?.data;
      if (data) {
        this.player.enqueue(data);
        this.cb.onState("speaking");
      }
    }
    if (sc?.inputTranscription?.text) this.cb.onUserText(sc.inputTranscription.text);
    if (sc?.outputTranscription?.text) this.cb.onModelText(sc.outputTranscription.text);
    if (sc?.turnComplete) {
      this.cb.onTurnComplete();
      if (!this.player.isPlaying) this.cb.onState("listening");
    }
  }

  setMuted(m: boolean) {
    this.mic.setMuted(m);
  }

  async stop() {
    this.stopped = true;
    this.mic.stop();
    this.loopback.stop();
    await this.player.close();
    try {
      this.session?.close();
    } catch {
      /* ignore */
    }
  }
}
