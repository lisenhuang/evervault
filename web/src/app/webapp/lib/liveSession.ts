// Realtime voice call backed by the Gemini Live API. Streams mic audio up and the model's spoken
// reply down over a WebSocket — hands-free, with server-side voice-activity detection (no push-to-
// talk) and barge-in (interrupt the model by speaking). Uses the user's own key, browser → Google.

import { GoogleGenAI, Modality, StartSensitivity, EndSensitivity, type LiveServerMessage } from "@google/genai";
import { AudioPlayer, MicStreamer, isIOS } from "./liveAudio";
import { EchoLoopback } from "./echoLoopback";
import { MEMORY_PERSONA, RECALL_MEMORY_DECLARATION, runRecallTool } from "./recallTool";
import { isTaskTool, runTaskTool, TASK_TOOL_DECLARATIONS, TASKS_PERSONA } from "./taskTools";
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

// A single Live WebSocket lives for a capped span (~10 min) and Google closes it, even mid-conversation.
// Session resumption lets a fresh socket pick the SAME conversation back up (full context intact) via a
// handle Gemini hands us periodically — so we transparently reconnect and the call feels continuous. This
// bounds how many times we retry a genuinely broken connection before giving up so a dead key/quota can't
// loop forever; the counter resets every time a socket comes up healthy (see setupComplete handling).
const MAX_RECONNECTS = 6;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class LiveSession {
  private session?: SessionHandle;
  private mic = new MicStreamer();
  private player = new AudioPlayer();
  private loopback = new EchoLoopback();
  private cb!: LiveCallbacks;
  private stopped = false;
  /**
   * Set when the model's voice plays on a path the platform's echo canceller can't reference —
   * always on iOS (its canceller only "hears" MediaStream-element playback, never Web Audio),
   * and elsewhere when the loopback fails. The session then runs half duplex: mic chunks are
   * dropped while model audio is sounding, so the speaker's sound can't come back as "user
   * speech" and make the model interrupt itself. Null = echo-cancelled path, full duplex.
   */
  private gateReason: "ios" | "no-loopback" | null = null;
  /** User declared headphones: no acoustic echo, so the gate lifts and voice barge-in returns. */
  private headphones = false;
  private gatedSinceMs: number | null = null;
  private streamEndSent = false;
  /** A model turn is streaming audio (set on its first chunk, cleared on turnComplete/interrupted). */
  private modelTurnActive = false;
  /** Tap-to-interrupt: swallow the rest of the current turn's audio and transcript. */
  private discardTurnAudio = false;
  /**
   * Latest resumption handle Gemini has issued for this conversation. Feeding it to a new socket
   * resumes the SAME session — the model keeps the full history, so a reconnect is invisible to the
   * user. Null until the first `sessionResumptionUpdate` arrives (a brand-new call has no handle yet).
   */
  private resumptionHandle: string | null = null;
  /** A resume is mid-flight: the socket is being swapped, so mic chunks are dropped until it's back. */
  private reconnecting = false;
  /** Consecutive resume attempts since the last healthy socket; caps runaway reconnect loops. */
  private reconnectAttempts = 0;
  /**
   * A non-retryable failure landed (e.g. the key's quota/rate limit was hit — common on a free Gemini
   * key). Resuming would just fail again instantly, so once this is set we stop and report the error
   * instead of reconnecting.
   */
  private fatal = false;

  constructor(
    private apiKey: string,
    private model: string,
    private voice: string,
    private memoryEnabled = false,
    private profileBlock?: string,
    private recentContext?: string,
    private language: Lang = "en",
    private agendaBlock?: string,
  ) {}

  async start(cb: LiveCallbacks): Promise<void> {
    this.cb = cb;
    cb.onState("connecting");
    await this.player.resume();
    this.player.onIdle = () => {
      if (!this.stopped) cb.onState("listening");
    };

    await this.connect();

    await this.mic.start((b64) => {
      // A resume is swapping the socket underneath us — the old session is closing and the new one
      // isn't ready. Drop the chunk (the sub-second gap is inaudible) rather than send into the void.
      if (this.reconnecting) return;
      if (this.halfDuplex && this.player.echoRisk) {
        // The speaker is (or was just) sounding the model's voice with no echo cancellation:
        // drop the chunk. The gate closes the moment a turn's first buffer is scheduled —
        // before any sound leaves the hardware — so no echo-bearing chunk slips through.
        if (this.gatedSinceMs == null) {
          this.gatedSinceMs = Date.now();
        } else if (!this.streamEndSent && Date.now() - this.gatedSinceMs > 1000) {
          // Gemini caches trailing audio across pauses; after a long gate, flush it so stale
          // pre-gate sound isn't glued onto the front of the user's next utterance.
          this.session?.sendRealtimeInput({ audioStreamEnd: true });
          this.streamEndSent = true;
        }
        return;
      }
      this.gatedSinceMs = null;
      this.streamEndSent = false;
      this.session?.sendRealtimeInput({ audio: { data: b64, mimeType: "audio/pcm;rate=16000" } });
    });

    // Play the model's voice. On desktop/Android, route it through the echo-cancelling loopback
    // (puts it on the path the browser's echo canceller references, so the model doesn't interrupt
    // itself — see echoLoopback.ts). It comes after mic.start() because iOS only lets a MediaStream
    // element play while the page is already capturing.
    //
    // On iOS the loopback plays back SILENTLY (WebKit can't carry Web Audio output through it), so
    // there we play straight to the speaker to stay audible. Direct output is invisible to the
    // echo canceller, so any such path also flips the session to half duplex (see gateReason).
    if (isIOS()) {
      this.player.useDirectOutput();
      this.gateReason = "ios";
    } else {
      try {
        await this.loopback.start(this.player.stream);
      } catch (e) {
        console.warn("[live] echo-cancelling loopback unavailable; using direct speaker output", e);
        this.loopback.stop();
        this.player.useDirectOutput();
        this.gateReason = "no-loopback";
      }
    }

    cb.onState("listening");
  }

  /**
   * Open a Live socket for this call. Used both for the first connect and for every seamless resume:
   * when `resumptionHandle` is set, Gemini restores the existing conversation onto the new socket, so
   * the model continues with full context. `contextWindowCompression` lifts the fixed session-duration
   * cap (a sliding window keeps the context bounded), so long calls don't die from context overflow —
   * the only reconnects left are the periodic connection resets, which resumption stitches over.
   */
  private async connect(): Promise<void> {
    const ai = new GoogleGenAI({ apiKey: this.apiKey });
    this.session = await ai.live.connect({
      model: this.model,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        // Keep the call alive across Google's per-connection time limit: hand back the resumption
        // handle so this reconnect continues the same conversation, and compress the context window
        // so an hours-long call never terminates from hitting the model's context ceiling.
        sessionResumption: this.resumptionHandle ? { handle: this.resumptionHandle } : {},
        contextWindowCompression: { slidingWindow: {} },
        // When memory is on, give the model the recall_memory + task tools and a persona that knows it
        // has memory + a task list, so it can search past chats and manage tasks mid-call.
        ...(this.memoryEnabled
          ? { tools: [{ functionDeclarations: [RECALL_MEMORY_DECLARATION, ...TASK_TOOL_DECLARATIONS] }] }
          : {}),
        // Time + agenda are captured at connect; a multi-hour call won't refresh them (acceptable — the
        // list_tasks tool gives freshness mid-call). The profile block grounds the call from the first word.
        systemInstruction: [
          this.memoryEnabled && this.profileBlock ? this.profileBlock : "",
          this.memoryEnabled && this.agendaBlock ? this.agendaBlock : "",
          this.memoryEnabled && this.recentContext ? this.recentContext : "",
          this.memoryEnabled ? MEMORY_PERSONA : "",
          this.memoryEnabled ? TASKS_PERSONA : "",
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
        onerror: (e: ErrorEvent) => this.onSocketError(e),
        onclose: (e: CloseEvent) => this.onSocketClose(e),
      },
    });
  }

  /**
   * A quota / rate-limit signal from Google (RESOURCE_EXHAUSTED, HTTP 429, "quota exceeded"). These
   * commonly hit a free key, and unlike a plain connection drop they DON'T heal on reconnect — the
   * resumed socket would fail the same way — so we treat them as terminal instead of retrying.
   */
  private isQuotaError(text: string): boolean {
    return /quota|resource[_\s-]?exhausted|\bexhausted\b|rate[_\s-]?limit|too many requests|\b429\b/i.test(text);
  }

  /** Give up on the call for a reason retrying can't fix, and surface a clear message to the user. */
  private failFatally(detail: string) {
    this.fatal = true;
    console.warn("[live] non-retryable failure; not resuming:", detail);
    this.cb.onError("The AI provider's usage limit was reached, so the call had to stop.");
    this.cb.onState("error");
  }

  /**
   * The socket errored. A quota/limit error is terminal (see failFatally). Otherwise, on a resumable
   * session this isn't terminal — the `onclose` that follows transparently resumes — so we stay quiet
   * and let that happen. We only surface a generic error when there's nothing to resume from (a failed
   * first connect) or we've exhausted our retry budget.
   */
  private onSocketError(e: ErrorEvent) {
    const msg = e?.message || "";
    if (this.isQuotaError(msg)) return this.failFatally(msg);
    if (!this.stopped && !this.fatal && this.resumptionHandle && this.reconnectAttempts < MAX_RECONNECTS) {
      console.warn("[live] socket error; will attempt resume", msg);
      return;
    }
    this.cb.onError(msg || "Voice connection error.");
    this.cb.onState("error");
  }

  /**
   * The socket closed. If the user hung up (`stopped`) or we've already failed fatally, we're done. A
   * quota/limit close is terminal. Otherwise, if we hold a resumption handle and still have retries
   * left, reconnect seamlessly — the call never leaves the live state, so the CallBar keeps its timer
   * running and the user sees no interruption. Only when we can't resume do we report the call closed.
   */
  private onSocketClose(e?: CloseEvent) {
    if (this.stopped || this.reconnecting || this.fatal) return;
    const reason = e?.reason || "";
    if (this.isQuotaError(reason)) return this.failFatally(reason);
    if (this.resumptionHandle && this.reconnectAttempts < MAX_RECONNECTS) {
      void this.reconnect();
      return;
    }
    this.cb.onState("closed");
  }

  /** Bring up a fresh socket that resumes the conversation, retrying with backoff on transient failure. */
  private async reconnect(): Promise<void> {
    this.reconnecting = true;
    this.reconnectAttempts += 1;
    // Reset only the per-SOCKET turn state; the conversation itself is restored from the handle, so
    // history, memory, and the model's mid-thought context all survive the swap.
    this.modelTurnActive = false;
    this.discardTurnAudio = false;
    this.streamEndSent = false;
    this.gatedSinceMs = null;
    try {
      await this.connect();
      if (this.stopped) {
        // The user hung up while this resume was in flight — close the socket we just opened and bail,
        // otherwise it would linger after stop() already closed the previous one.
        try {
          this.session?.close();
        } catch {
          /* ignore */
        }
        this.reconnecting = false;
        return;
      }
      this.reconnecting = false;
      // Mic streaming resumes automatically (its callback reads the live `this.session`). If the new
      // socket dies again, its own onclose schedules the next attempt.
      if (!this.player.isPlaying) this.cb.onState("listening");
    } catch (e) {
      this.reconnecting = false;
      const msg = e instanceof Error ? e.message : String(e);
      // A quota/limit error means the key is spent — retrying can't help, so stop here.
      if (this.isQuotaError(msg)) return this.failFatally(msg);
      console.warn(`[live] resume attempt ${this.reconnectAttempts} failed`, e);
      if (this.stopped) return;
      if (this.reconnectAttempts < MAX_RECONNECTS) {
        await delay(400 * this.reconnectAttempts);
        if (!this.stopped && !this.reconnecting) void this.reconnect();
      } else {
        this.cb.onError("Voice connection lost. Please start the call again.");
        this.cb.onState("error");
      }
    }
  }

  private async onMessage(m: LiveServerMessage) {
    // A socket just came up healthy (initial connect or a resume): clear the failure counter so the
    // next connection-limit drop gets a fresh budget of resume attempts.
    if (m.setupComplete) this.reconnectAttempts = 0;
    // Gemini periodically issues a handle that lets a new socket resume THIS conversation with full
    // context. Stash the latest resumable one — it's what makes a reconnect feel like nothing happened.
    const resume = m.sessionResumptionUpdate;
    if (resume?.resumable && resume.newHandle) this.resumptionHandle = resume.newHandle;
    // Server is about to close the connection (its per-connection cap). No action needed — the onclose
    // that follows resumes from the stored handle; we just log how much runway it gave us.
    if (m.goAway) console.info("[live] server goAway; will resume", m.goAway.timeLeft);

    // The model asked to search memory or manage tasks: run the tool(s) and send the results back.
    // Live always populates the call `id`, which sendToolResponse must echo so the model can match it.
    if (m.toolCall?.functionCalls?.length) {
      const calls = m.toolCall.functionCalls;
      const results = await Promise.all(
        calls.map((c) => {
          const name = c.name ?? "";
          const args = c.args ?? {};
          return isTaskTool(name) ? runTaskTool(name, args) : runRecallTool(args);
        }),
      );
      this.session?.sendToolResponse({
        functionResponses: calls.map((c, i) => ({ id: c.id, name: c.name, response: { output: results[i] } })),
      });
      return;
    }

    const sc = m.serverContent;
    if (sc?.interrupted) {
      this.player.clear(); // barge-in: drop whatever the model was saying
      this.modelTurnActive = false;
      this.discardTurnAudio = false;
      this.cb.onState("listening");
    }
    for (const p of sc?.modelTurn?.parts ?? []) {
      const data = p.inlineData?.data;
      // After a tap-to-interrupt, the server keeps streaming the rest of the turn (there's no
      // cancel message in the Live API) — swallow it so nothing plays or re-enters "speaking".
      if (data && !this.discardTurnAudio) {
        this.player.enqueue(data);
        this.modelTurnActive = true;
        this.cb.onState("speaking");
      }
    }
    if (sc?.inputTranscription?.text) this.cb.onUserText(sc.inputTranscription.text);
    // Also drop the discarded turn's transcript: the chat log (and the memories built from it)
    // should only contain speech the user actually heard, matching real barge-in semantics.
    if (sc?.outputTranscription?.text && !this.discardTurnAudio) this.cb.onModelText(sc.outputTranscription.text);
    if (sc?.turnComplete) {
      this.modelTurnActive = false;
      this.discardTurnAudio = false;
      this.cb.onTurnComplete();
      if (!this.player.isPlaying) this.cb.onState("listening");
    }
  }

  setMuted(m: boolean) {
    this.mic.setMuted(m);
  }

  /** The model's voice plays on an echo-prone path here, so the headphones escape is relevant. */
  get echoProne(): boolean {
    return this.gateReason !== null;
  }

  /** Mic gating in force: echo-prone and the user hasn't declared headphones. */
  get halfDuplex(): boolean {
    return this.echoProne && !this.headphones;
  }

  setHeadphones(on: boolean) {
    this.headphones = on;
  }

  /**
   * Tap-to-interrupt for half-duplex mode (voice can't barge in there): stop playback locally and
   * swallow the rest of the turn. The server keeps generating — its context retains the full
   * reply — but the user stops hearing it, and the mic reopens after the short post-stop tail.
   */
  interrupt() {
    if (!this.modelTurnActive && !this.player.isPlaying) return;
    // Only swallow the remainder of a turn that is still streaming. A tap during the playback
    // drain after turnComplete has nothing left to discard — and a stale flag would swallow the
    // entire NEXT reply, since only interrupted/turnComplete clear it.
    this.discardTurnAudio = this.modelTurnActive;
    this.player.clear();
    this.cb.onState("listening");
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
