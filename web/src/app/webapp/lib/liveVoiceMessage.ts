// One-shot voice message backed by the Gemini Live API. A voice message is a single push-to-talk turn:
// the user taps the mic, speaks, and taps send — but under the hood it runs as a short Live session so
// the reply comes back as audio + text in ONE streaming call (no separate transcribe → reply → synthesize
// round-trips). Keyless, exactly like the call: our backend mints an ephemeral token and the browser
// connects DIRECTLY to Google.
//
// Flow: start() opens the mic and (in the background) the socket, prefilling the FULL prior transcript so
// the reply remembers the whole mixed text+voice conversation; the mic streams as the user talks. On send,
// endCapture() stops the mic and hands back the recorded clip; awaitReply() marks the turn complete and
// streams back the model's spoken reply + both transcripts. If anything about the Live path fails, the
// caller still holds the recorded WAV and falls back to the classic TTS pipeline.

import { GoogleGenAI, Modality, type LiveServerMessage } from "@google/genai";
import { api } from "../authApi";
import { AudioPlayer, MicStreamer, isIOS, setAudioSessionType } from "./liveAudio";
import { arrayBufferToBase64, encodeWav, mergeFloat32, voicedSeconds } from "./audio";
import { buildLiveSystemInstruction, buildLiveToolDeclarations, dispatchLiveToolCalls } from "./liveShared";
import type { Content } from "./gemini";
import type { Lang } from "@/i18n/config";

type SessionHandle = Awaited<ReturnType<GoogleGenAI["live"]["connect"]>>;

/** The recorded clip, in the exact shape the classic recorder returns — so the TTS fallback can consume it. */
export type VoiceWav = { base64: string; mimeType: string; seconds: number; voicedSeconds: number };

/** The finished Live reply: the final transcripts for both sides + the model's spoken audio for replay. */
export type LiveVoiceReply = {
  userText: string;
  modelText: string;
  audio: { base64: string; sampleRate: number } | null;
};

export type LiveVoiceOpts = {
  model: string;
  voice: string;
  memoryEnabled: boolean;
  profileBlock?: string;
  stateBlock?: string;
  eventsBlock?: string;
  agendaBlock?: string;
  recentContext?: string;
  styleInstruction?: string;
  language?: Lang;
  /** The full prior transcript as Gemini Content[] (toContents of everything before this message). */
  history: Content[];
  /** Streams the assistant's transcript as it arrives, for the streaming reply bubble. */
  onModelText: (delta: string) => void;
  /** Streams the user's own transcript (the Live model's input transcription) as it arrives, for the
   *  human voice bubble — so their words show up live, not only once the reply finishes. */
  onUserText?: (delta: string) => void;
};

// Model audio streams back at 24 kHz mono PCM16 (same as the call).
const MODEL_SAMPLE_RATE = 24000;
// Backstop: if the model never signals turnComplete, stop waiting and let the caller fall back to TTS.
const REPLY_TIMEOUT_MS = 30_000;
// A slow connect shouldn't buffer unbounded audio; ~30 s of 16 kHz chunks is far more than any message.
const MAX_PENDING_CHUNKS = 400;

const b64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export class LiveVoiceMessage {
  private mic = new MicStreamer();
  private player = new AudioPlayer(MODEL_SAMPLE_RATE);
  private session?: SessionHandle;
  /** Socket open AND ready to receive audio (prefill + activityStart sent). */
  private connected = false;
  /** Connect failed, or the socket errored/closed before a clean reply — the caller must fall back. */
  private failed = false;
  /** The caller tore this down (dropped clip / cancel / fallback); a late connect must not proceed. */
  private stopped = false;
  private tokenAttempt = 0;
  /** Mic chunks captured before the socket came up, flushed to Gemini once it's ready. */
  private pending: string[] = [];

  private userText = "";
  private modelText = "";
  private modelPcm: Uint8Array[] = [];
  private turnDone = false;
  /** The model signalled turnComplete — set even if awaitReply hasn't started yet, so a reply that
   *  completes before it's awaited resolves immediately instead of hanging. */
  private replyComplete = false;

  private settled = false;
  private resolveReply?: () => void;
  private rejectReply?: (e: unknown) => void;
  private replyTimer?: ReturnType<typeof setTimeout>;

  /** Called once the streamed reply audio has finished playing (so the caller can clear its play state). */
  onPlaybackIdle?: () => void;

  constructor(private opts: LiveVoiceOpts) {
    // No loopback for a one-shot turn (the mic is closed while the reply plays, so there's no echo path):
    // route audio straight to the speaker. Without this it would play into a MediaStream and stay silent.
    this.player.useDirectOutput();
    this.player.onIdle = () => {
      // Only once the reply turn is done (a transient mid-stream gap also empties the queue). Notify the
      // caller to clear its play-state, then release the audio context — the clip has finished playing.
      if (this.turnDone) {
        this.onPlaybackIdle?.();
        void this.player.close();
      }
    };
  }

  /**
   * Acquire the mic and begin capturing + streaming; open the socket in the BACKGROUND (so recording
   * starts as fast as the classic recorder — no waiting on the token mint + connect). Resolves once the
   * mic is live; throws a typed MicError if acquisition fails. The socket may still be connecting when
   * this resolves — endCapture() reports whether it made it.
   */
  async start(): Promise<void> {
    await this.player.resume(); // the mic press is the user gesture — unlock playback now
    this.mic.enableCapture(); // keep a local copy of every chunk for the WAV (fallback + memory)
    // Throws a typed MicError (see mic.ts) so the caller can show an accurate mic message.
    await this.mic.start((b64) => {
      if (this.stopped) return;
      if (this.connected && this.session) {
        this.session.sendRealtimeInput({ audio: { data: b64, mimeType: "audio/pcm;rate=16000" } });
      } else if (!this.failed) {
        this.pending.push(b64);
        if (this.pending.length > MAX_PENDING_CHUNKS) this.pending.shift();
      }
    });
    // Fire-and-forget connect; failures just flip `failed`, which routes the caller to the TTS fallback.
    void this.connect();
  }

  private async connect(): Promise<void> {
    try {
      const token = await this.fetchLiveToken(this.tokenAttempt);
      if (this.stopped) return;
      const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: "v1alpha" } });
      this.session = await ai.live.connect({
        model: this.opts.model,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.opts.voice } } },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          tools: buildLiveToolDeclarations(this.opts.memoryEnabled),
          systemInstruction: buildLiveSystemInstruction({
            memoryEnabled: this.opts.memoryEnabled,
            profileBlock: this.opts.profileBlock,
            stateBlock: this.opts.stateBlock,
            eventsBlock: this.opts.eventsBlock,
            agendaBlock: this.opts.agendaBlock,
            recentContext: this.opts.recentContext,
            // The prior mixed text+voice conversation goes into the system instruction as a transcript
            // (not via sendClientContent — that's only supported for this Live model with a history-config
            // flag the SDK doesn't expose, and using it broke every message after the first).
            conversationBlock: renderConversation(this.opts.history),
            styleInstruction: this.opts.styleInstruction,
            language: this.opts.language,
          }),
          // Push-to-talk: WE own the turn boundary (activityStart on connect, activityEnd on send), so
          // turn off automatic voice-activity detection — no VAD guessing when the user started/stopped.
          realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
        },
        callbacks: {
          onopen: () => {},
          onmessage: (m: LiveServerMessage) => void this.onMessage(m),
          onerror: () => this.onSocketDown(),
          onclose: () => this.onSocketDown(),
        },
      });
      if (this.stopped) {
        try {
          this.session.close();
        } catch {
          /* ignore */
        }
        return;
      }
      // Open the user's turn (the prior conversation is already in the system instruction as a
      // transcript — see conversationBlock), then flush any audio captured while connecting.
      this.session.sendRealtimeInput({ activityStart: {} });
      for (const b64 of this.pending) {
        this.session.sendRealtimeInput({ audio: { data: b64, mimeType: "audio/pcm;rate=16000" } });
      }
      this.pending = [];
      this.connected = true;
    } catch {
      // Any failure to mint/connect: the caller falls back to TTS with the recorded WAV.
      this.onSocketDown();
    }
  }

  private async fetchLiveToken(attempt: number): Promise<string> {
    const res = await api(`/api/chat/ai/live-token?attempt=${attempt}`, { method: "POST" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw Object.assign(new Error(body || `Could not start the voice reply (HTTP ${res.status}).`), {
        status: res.status,
      });
    }
    const data = (await res.json()) as { token?: string };
    if (!data.token) throw new Error("The server did not return a live token.");
    return data.token;
  }

  /** The socket errored/closed or connect failed. Flip the flags and reject a reply that's being awaited. */
  private onSocketDown() {
    if (this.replyComplete) return; // a close AFTER the reply completed is normal — ignore it
    this.connected = false;
    this.failed = true;
    if (!this.settled && this.rejectReply) {
      this.settled = true;
      if (this.replyTimer) clearTimeout(this.replyTimer);
      this.rejectReply(new Error("live-unavailable"));
    }
  }

  /** Close just the WebSocket (the scheduled reply audio keeps playing from the AudioContext). Called
   *  once the reply turn completes so a finished session doesn't hold a pooled key/token slot open. */
  private closeSession() {
    if (this.replyTimer) clearTimeout(this.replyTimer);
    try {
      this.session?.close();
    } catch {
      /* ignore */
    }
    this.session = undefined;
  }

  private async onMessage(m: LiveServerMessage) {
    if (m.toolCall?.functionCalls?.length) {
      this.session?.sendToolResponse({
        functionResponses: await dispatchLiveToolCalls(m.toolCall.functionCalls),
      });
      return;
    }
    const sc = m.serverContent;
    for (const p of sc?.modelTurn?.parts ?? []) {
      const data = p.inlineData?.data;
      if (data) {
        this.player.enqueue(data); // stream the spoken reply as it arrives
        this.modelPcm.push(b64ToBytes(data)); // and keep it for the bubble's replay button
      }
    }
    if (sc?.inputTranscription?.text) {
      this.userText += sc.inputTranscription.text;
      this.opts.onUserText?.(sc.inputTranscription.text);
    }
    if (sc?.outputTranscription?.text) {
      this.modelText += sc.outputTranscription.text;
      this.opts.onModelText(sc.outputTranscription.text);
    }
    if (sc?.turnComplete) {
      // Mark complete even if awaitReply hasn't started yet (its entry checks replyComplete), then close
      // the socket — the reply audio is already scheduled in the player and plays on without it.
      this.replyComplete = true;
      if (!this.settled) {
        this.settled = true;
        if (this.replyTimer) clearTimeout(this.replyTimer);
        this.resolveReply?.();
      }
      this.closeSession();
    }
  }

  /**
   * Stop capturing and build the recorded clip (byte-identical to the classic recorder, so the TTS
   * fallback can use it). Returns whether the Live socket is up: if not, the caller runs the fallback.
   */
  endCapture(): { wav: VoiceWav; connected: boolean } {
    this.mic.stop();
    const samples = mergeFloat32(this.mic.takeCapturedSamples());
    const wav: VoiceWav = {
      base64: arrayBufferToBase64(encodeWav(samples, 16000)),
      mimeType: "audio/wav",
      seconds: samples.length / 16000,
      voicedSeconds: voicedSeconds(samples, 16000),
    };
    return { wav, connected: this.connected && !this.failed };
  }

  /**
   * Signal the end of the user's turn and await the model's reply. Resolves with the transcripts + spoken
   * audio on turnComplete; REJECTS if the Live session fails or times out (the caller then falls back to
   * TTS). Only valid after endCapture() reported connected: true. The reply audio keeps playing after this
   * resolves (until it drains — see onPlaybackIdle); stopPlayback() cuts it short.
   */
  async awaitReply(): Promise<LiveVoiceReply> {
    if (!this.connected || this.failed || !this.session) throw new Error("live-unavailable");
    setAudioSessionType("playback"); // the mic is closed now — make the reply audible through the Silent switch
    void this.player.resume(); // re-confirm the playback context within the send-tap gesture (iOS)
    this.session.sendRealtimeInput({ activityEnd: {} });
    // Wait for turnComplete — unless it already arrived (a reply that completed before we started awaiting),
    // in which case resolve immediately rather than hang.
    if (!this.replyComplete) {
      await new Promise<void>((resolve, reject) => {
        this.resolveReply = resolve;
        this.rejectReply = reject;
        this.replyTimer = setTimeout(() => {
          if (!this.settled) {
            this.settled = true;
            reject(new Error("live-timeout"));
          }
        }, REPLY_TIMEOUT_MS);
      });
    }
    this.turnDone = true;
    const audio = this.modelPcm.length
      ? { base64: bytesToBase64(concatBytes(this.modelPcm)), sampleRate: MODEL_SAMPLE_RATE }
      : null;
    return { userText: this.userText.trim(), modelText: this.modelText.trim(), audio };
  }

  /** Whether reply audio is still (about to be) sounding — drives the caller's play-state cleanup. */
  get playing(): boolean {
    return this.player.isPlaying;
  }

  /** The user's transcription so far — used to seed the human bubble with anything the Live model
   *  transcribed before the send tap (subsequent deltas stream in via onUserText). */
  get currentUserText(): string {
    return this.userText;
  }

  /** Pause / resume the streamed reply audio (the bubble's Play button, while the clip is still streaming). */
  pausePlayback() {
    this.player.pause();
  }
  resumePlayback() {
    void this.player.resume();
  }

  /** Cut the streamed reply audio short (a new recording started, or the user navigated away). */
  stopPlayback() {
    void this.player.close();
    setAudioSessionType("auto");
    try {
      this.session?.close();
    } catch {
      /* ignore */
    }
  }

  /** Tear everything down without generating a reply (dropped clip, cancel, or falling back to TTS). */
  async abandon(): Promise<void> {
    this.stopped = true;
    if (this.replyTimer) clearTimeout(this.replyTimer);
    this.mic.stop();
    await this.player.close();
    setAudioSessionType("auto");
    try {
      this.session?.close();
    } catch {
      /* ignore */
    }
  }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

// Keep the transcript block bounded so a long chat doesn't bloat the system instruction; the most
// recent turns matter most for continuing the conversation.
const CONVERSATION_MAX_CHARS = 12000;

/**
 * Render the prior conversation (already toContents'd, so mixed text+voice) as a plain transcript for
 * the system instruction. This is how a per-message Live session "remembers the entire context" — the
 * realtime call gets this for free from its persistent server-side history, but a voice message opens a
 * fresh session each time. Image/audio-only parts contribute no text and are skipped.
 */
function renderConversation(history: Content[]): string {
  const lines: string[] = [];
  for (const c of history) {
    const text = (c.parts ?? [])
      .map((p) => p.text ?? "")
      .filter(Boolean)
      .join(" ")
      .trim();
    if (!text) continue;
    lines.push(`${c.role === "model" ? "You" : "User"}: ${text}`);
  }
  if (!lines.length) return "";
  let block = lines.join("\n");
  if (block.length > CONVERSATION_MAX_CHARS) block = `…\n${block.slice(block.length - CONVERSATION_MAX_CHARS)}`;
  return (
    "The conversation so far (most recent last) — continue it naturally, drawing on this so the user " +
    `feels remembered:\n${block}`
  );
}
