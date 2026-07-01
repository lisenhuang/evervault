// Realtime voice call backed by the Gemini Live API. Streams mic audio up and the model's spoken
// reply down over a WebSocket — hands-free, with server-side voice-activity detection (no push-to-
// talk) and barge-in (interrupt the model by speaking). Uses the user's own key, browser → Google.

import { GoogleGenAI, Modality, StartSensitivity, EndSensitivity, type LiveServerMessage } from "@google/genai";
import { AudioPlayer, MicStreamer, isIOS } from "./liveAudio";
import { EchoLoopback } from "./echoLoopback";
import { MEMORY_PERSONA, RECALL_MEMORY_DECLARATION, runRecallTool } from "./recallTool";
import { currentTimeContext } from "./time";
import { aiReplyDirective, type Lang } from "@/i18n/config";

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
    private memoryEnabled = false,
    private profileBlock?: string,
    private recentContext?: string,
    private language: Lang = "en",
  ) {}

  async start(cb: LiveCallbacks): Promise<void> {
    this.cb = cb;
    cb.onState("connecting");
    await this.player.resume();
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
        // When memory is on, give the model the recall_memory tool + a persona that knows it has
        // memory, so it can search past conversations mid-call instead of denying it remembers.
        ...(this.memoryEnabled ? { tools: [{ functionDeclarations: [RECALL_MEMORY_DECLARATION] }] } : {}),
        // Time is captured at connect; a multi-hour call won't refresh it (acceptable for this use).
        // The profile block (what we already know about the user) grounds the call from the first word.
        systemInstruction: [
          this.memoryEnabled && this.profileBlock ? this.profileBlock : "",
          this.memoryEnabled && this.recentContext ? this.recentContext : "",
          this.memoryEnabled ? MEMORY_PERSONA : "",
          SYSTEM_INSTRUCTION,
          // Steer the spoken reply into the selected UI language (empty for English).
          aiReplyDirective(this.language),
          currentTimeContext(),
        ]
          .filter(Boolean)
          .join("\n\n"),
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
        onmessage: (m: LiveServerMessage) => void this.onMessage(m),
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

    // Play the model's voice. On desktop/Android, route it through the echo-cancelling loopback
    // (puts it on the path the browser's echo canceller references, so the model doesn't interrupt
    // itself — see echoLoopback.ts). It comes after mic.start() because iOS only lets a MediaStream
    // element play while the page is already capturing.
    //
    // On iOS the loopback plays back SILENTLY (WebKit can't carry Web Audio output through it), so
    // there we play straight to the speaker to stay audible; iOS echo is left to the VAD tuning
    // above (and is the candidate for an in-app echo canceller if that proves insufficient).
    if (isIOS()) {
      this.player.useDirectOutput();
    } else {
      try {
        await this.loopback.start(this.player.stream);
      } catch (e) {
        console.warn("[live] echo-cancelling loopback unavailable; using direct speaker output", e);
        this.loopback.stop();
        this.player.useDirectOutput();
      }
    }

    cb.onState("listening");
  }

  private async onMessage(m: LiveServerMessage) {
    // The model asked to search memory: run the tool(s) and send the results back. Live always
    // populates the call `id`, which sendToolResponse must echo so the model can match the reply.
    if (m.toolCall?.functionCalls?.length) {
      const calls = m.toolCall.functionCalls;
      const results = await Promise.all(calls.map((c) => runRecallTool(c.args ?? {})));
      this.session?.sendToolResponse({
        functionResponses: calls.map((c, i) => ({ id: c.id, name: c.name, response: { output: results[i] } })),
      });
      return;
    }

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
