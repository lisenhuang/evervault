// Realtime voice call backed by the Gemini Live API. Streams mic audio up and the model's spoken
// reply down over a WebSocket — hands-free, with server-side voice-activity detection (no push-to-
// talk) and barge-in (interrupt the model by speaking). Keyless: our backend mints a short-lived
// ephemeral token from a pooled key and the browser connects DIRECTLY to Google with it — no audio
// through our servers, and the real key never leaves the backend. On a quota/auth failure we re-mint
// (the server rotates to the next key) and resume, so the call fails over across keys.

import { GoogleGenAI, Modality, StartSensitivity, EndSensitivity, type LiveServerMessage } from "@google/genai";
import { api } from "../authApi";
import { AudioPlayer, MicStreamer, isIOS } from "./liveAudio";
import { EchoLoopback } from "./echoLoopback";
import { CAPABILITY_BOUNDS } from "./persona";
import { MEMORY_PERSONA, RECALL_MEMORY_DECLARATION, runRecallTool } from "./recallTool";
import { isTaskTool, runTaskTool, TASK_TOOL_DECLARATIONS, TASKS_PERSONA } from "./taskTools";
import { isSuggestionTool, RECORD_SUGGESTION_DECLARATION, runSuggestionTool, SUGGESTION_PERSONA } from "./suggestionTool";
import { currentTimeContext } from "./time";
import { aiReplyDirective, type Lang } from "@/i18n/config";

export type LiveState = "connecting" | "listening" | "speaking" | "error" | "closed";

export type LiveCallbacks = {
  onState: (s: LiveState) => void;
  onUserText: (delta: string) => void;
  onModelText: (delta: string) => void;
  onTurnComplete: () => void;
  onError: (msg: string) => void;
  /**
   * The call auto-closed because the user went silent for the whole idle window (see IDLE_TIMEOUT_MS)
   * on their turn to speak — e.g. they fell asleep mid-conversation. Fires just before the "closed"
   * state so the UI can explain why the call ended rather than looking like a plain hang-up.
   */
  onIdleTimeout?: () => void;
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

// Auto-hang-up guard for an abandoned call. A Live socket bills for the whole time it's open, even
// in dead silence, so if the user never says anything on their turn for this long — they walked away
// or fell asleep mid-conversation — we close the call for them instead of burning tokens on nothing.
// Only the user's silent time counts: the window resets whenever the user or the model is speaking,
// so a long model monologue or an active back-and-forth never trips it.
const IDLE_TIMEOUT_MS = 60_000;
// How often to check the idle window. Sub-second precision isn't needed — a coarse tick keeps the
// timer cheap and the close fires within a second of the threshold.
const IDLE_CHECK_MS = 1_000;

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
  /**
   * Which pooled key to mint the next ephemeral token from (0 = first). Advances on every (re)connect
   * so a resume after a key's quota/auth failure gets a token on a DIFFERENT key — this is what makes
   * the realtime call fail over across keys. Monotonic; the server wraps it modulo the key count.
   */
  private tokenAttempt = 0;
  /**
   * Wall-clock of the last moment the conversation was audibly active — either party speaking. The
   * idle monitor closes the call once this is IDLE_TIMEOUT_MS in the past (see markVoiceActivity /
   * startIdleMonitor). 0 until the monitor starts.
   */
  private lastVoiceActivityMs = 0;
  private idleTimer?: ReturnType<typeof setInterval>;

  constructor(
    private model: string,
    private voice: string,
    private memoryEnabled = false,
    private profileBlock?: string,
    private recentContext?: string,
    private language: Lang = "en",
    private agendaBlock?: string,
    // The user's chosen response-style directive for live calls ("" when they left it on default).
    private styleInstruction?: string,
  ) {}

  async start(cb: LiveCallbacks): Promise<void> {
    this.cb = cb;
    cb.onState("connecting");
    await this.player.resume();
    this.player.onIdle = () => {
      if (!this.stopped) cb.onState("listening");
    };

    await this.connectInitial();

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
    this.startIdleMonitor();
  }

  /**
   * Note that the conversation is audibly active right now, resetting the idle countdown. Called
   * whenever the user speaks or the model is streaming audio, so the auto-hang-up only elapses during
   * a genuine silence on the user's turn — never mid-utterance and never during the model's reply.
   */
  private markVoiceActivity() {
    this.lastVoiceActivityMs = Date.now();
  }

  /**
   * Start watching for an abandoned call. On each tick, if the model isn't currently speaking and no
   * reconnect is in flight, and the user has been silent for the whole idle window, hang up on their
   * behalf. Idempotent-ish: any existing timer is cleared first so a resume never stacks two monitors.
   */
  private startIdleMonitor() {
    this.stopIdleMonitor();
    this.markVoiceActivity();
    this.idleTimer = setInterval(() => {
      if (this.stopped || this.fatal) return;
      // While the model is talking or a socket swap is underway, it's not the user's silent turn —
      // keep the window fresh so those spans never count toward the timeout.
      if (this.modelTurnActive || this.reconnecting) return this.markVoiceActivity();
      if (Date.now() - this.lastVoiceActivityMs >= IDLE_TIMEOUT_MS) this.handleIdleTimeout();
    }, IDLE_CHECK_MS);
  }

  private stopIdleMonitor() {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** The user went silent for the whole idle window on their turn — close the call and say why. */
  private handleIdleTimeout() {
    if (this.stopped) return;
    this.stopIdleMonitor();
    console.info("[live] no user speech for", IDLE_TIMEOUT_MS, "ms — auto-closing the idle call");
    this.cb.onIdleTimeout?.();
    this.cb.onState("closed");
    void this.stop();
  }

  /**
   * Open a Live socket for this call. Used both for the first connect and for every seamless resume:
   * when `resumptionHandle` is set, Gemini restores the existing conversation onto the new socket, so
   * the model continues with full context. `contextWindowCompression` lifts the fixed session-duration
   * cap (a sliding window keeps the context bounded), so long calls don't die from context overflow —
   * the only reconnects left are the periodic connection resets, which resumption stitches over.
   */
  private async connect(): Promise<void> {
    // Mint a fresh short-lived token from our backend (which injects a pooled key) and connect DIRECTLY
    // to Google with it. tokenAttempt selects which key to mint from, so a resume after a bad key rotates.
    const token = await this.fetchLiveToken(this.tokenAttempt);
    const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: "v1alpha" } });
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
        // The record_suggestion tool is always available (forwarding feedback doesn't need memory);
        // when memory is on, also give the model recall_memory + the task tools and a persona that knows
        // it has memory + a task list, so it can search past chats and manage tasks mid-call.
        tools: [
          {
            functionDeclarations: [
              ...(this.memoryEnabled ? [RECALL_MEMORY_DECLARATION, ...TASK_TOOL_DECLARATIONS] : []),
              RECORD_SUGGESTION_DECLARATION,
            ],
          },
        ],
        // Time + agenda are captured at connect; a multi-hour call won't refresh them (acceptable — the
        // list_tasks tool gives freshness mid-call). The profile block grounds the call from the first word.
        systemInstruction: [
          this.memoryEnabled && this.profileBlock ? this.profileBlock : "",
          this.memoryEnabled && this.agendaBlock ? this.agendaBlock : "",
          this.memoryEnabled && this.recentContext ? this.recentContext : "",
          this.memoryEnabled ? MEMORY_PERSONA : "",
          this.memoryEnabled ? TASKS_PERSONA : "",
          SUGGESTION_PERSONA,
          SYSTEM_INSTRUCTION,
          // The user's chosen response style for calls (empty on default) — layered after the base
          // voice persona so it refines tone without dropping the "short and spoken" baseline.
          this.styleInstruction || "",
          CAPABILITY_BOUNDS,
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
   * Ask the backend for a short-lived Live ephemeral token. `attempt` rotates which pooled key it's
   * minted from. A 502 means every key failed to mint — surface it as a usage/limit signal (so the
   * quota path handles it) rather than a generic error.
   */
  private async fetchLiveToken(attempt: number): Promise<string> {
    const res = await api(`/api/chat/ai/live-token?attempt=${attempt}`, { method: "POST" });
    if (!res.ok) {
      // Propagate the backend body verbatim (it carries { error, referenceCode }) and the status, so
      // friendlyAiError can show the backend's reference code and classify it — instead of fabricating
      // a string that discards the code and double-reports. Status 502 stays retryable in connectInitial.
      const body = await res.text().catch(() => "");
      throw Object.assign(new Error(body || `Could not start the call (HTTP ${res.status}).`), {
        status: res.status,
      });
    }
    const data = (await res.json()) as { token?: string };
    if (!data.token) throw new Error("The server did not return a live token.");
    return data.token;
  }

  /**
   * First connect for the call. A quota/auth failure here isn't fatal: rotate to the next key (re-mint)
   * and retry, up to the reconnect budget, before surfacing the error to the caller. Non-quota errors
   * (mic, network) propagate immediately so startCall can show them.
   */
  private async connectInitial(): Promise<void> {
    for (;;) {
      try {
        await this.connect();
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // A 502 from live-token means all pooled keys failed to mint on this attempt; rotating to the
        // next key can still succeed, so retry it like a quota signal (the body no longer contains the
        // old "resource_exhausted" text now that we propagate the real backend response).
        const status = (e as { status?: number } | null)?.status;
        const retryable = this.isQuotaError(msg) || status === 502;
        if (retryable && !this.stopped && this.tokenAttempt < MAX_RECONNECTS) {
          this.tokenAttempt += 1; // next key, fresh token
          await delay(300);
          continue;
        }
        throw e;
      }
    }
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
    // Resumable: let the onclose that follows reconnect. On a quota/auth error, advance to the next key
    // first so the resume mints its token from a different key — that's what fails the call over.
    if (!this.stopped && !this.fatal && this.resumptionHandle && this.reconnectAttempts < MAX_RECONNECTS) {
      if (this.isQuotaError(msg)) this.tokenAttempt += 1;
      console.warn("[live] socket error; will attempt resume", msg);
      return;
    }
    if (this.isQuotaError(msg)) return this.failFatally(msg);
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
    // Resume if we can. On a quota/auth close, advance to the next key first so the resume mints from a
    // different key (failover); a plain connection cycle keeps the same key so resumption stays in-project.
    if (this.resumptionHandle && this.reconnectAttempts < MAX_RECONNECTS) {
      if (this.isQuotaError(reason)) this.tokenAttempt += 1;
      void this.reconnect();
      return;
    }
    if (this.isQuotaError(reason)) return this.failFatally(reason);
    this.cb.onState("closed");
  }

  /** Bring up a fresh socket that resumes the conversation, retrying with backoff on transient failure. */
  private async reconnect(): Promise<void> {
    this.reconnecting = true;
    this.reconnectAttempts += 1;
    // Note: tokenAttempt is NOT bumped here — a routine ~10-min socket cycle should resume on the SAME
    // key (so session resumption stays within one project). It's advanced only on a quota/auth failure
    // (see onSocketError/onSocketClose and the catch below), which is when we actually want a new key.
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
      console.warn(`[live] resume attempt ${this.reconnectAttempts} failed`, e);
      if (this.stopped) return;
      if (this.reconnectAttempts < MAX_RECONNECTS) {
        // Retry. If the failure was a spent/blocked key, advance so the next mint rolls to another key.
        if (this.isQuotaError(msg)) this.tokenAttempt += 1;
        await delay(400 * this.reconnectAttempts);
        if (!this.stopped && !this.reconnecting) void this.reconnect();
      } else if (this.isQuotaError(msg)) {
        // Out of retries and the keys are spent — a resume can't help, so stop with the limit message.
        this.failFatally(msg);
      } else {
        this.cb.onError("Voice connection lost. Please start the call again.");
        this.cb.onState("error");
      }
    }
  }

  private async onMessage(m: LiveServerMessage) {
    // A socket just came up healthy (initial connect or a resume): clear the failure counter so the
    // next connection-limit drop gets a fresh budget of resume attempts.
    if (m.setupComplete) {
      this.reconnectAttempts = 0;
      // A fresh socket just came up — treat that as activity so a slow connect/resume never counts
      // as idle time and hangs up the moment the user is finally live.
      this.markVoiceActivity();
    }
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
          // No image attachments during a voice call, so record_suggestion runs without screenshots.
          return isSuggestionTool(name)
            ? runSuggestionTool(args)
            : isTaskTool(name)
              ? runTaskTool(name, args)
              : runRecallTool(args);
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
        this.markVoiceActivity(); // the model is speaking — not the user's silent turn
        this.cb.onState("speaking");
      }
    }
    if (sc?.inputTranscription?.text) {
      this.cb.onUserText(sc.inputTranscription.text);
      this.markVoiceActivity(); // the user just spoke — reset the idle countdown
    }
    // Also drop the discarded turn's transcript: the chat log (and the memories built from it)
    // should only contain speech the user actually heard, matching real barge-in semantics.
    if (sc?.outputTranscription?.text && !this.discardTurnAudio) this.cb.onModelText(sc.outputTranscription.text);
    if (sc?.turnComplete) {
      this.modelTurnActive = false;
      this.discardTurnAudio = false;
      // The turn just ended — the user's silent turn starts now, so run the full idle window from here.
      this.markVoiceActivity();
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
    this.stopIdleMonitor();
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
