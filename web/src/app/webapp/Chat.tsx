"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Hand, Menu, MessageCircle, Sparkles, X } from "lucide-react";
import Sidebar from "./Sidebar";
import CallBar from "./CallBar";
import Composer, { type VoiceState } from "./Composer";
import KeyDrawer from "./KeyDrawer";
import MemoryPanel from "./MemoryPanel";
import MessageList from "./MessageList";
import ConfirmDialog from "@/components/ConfirmDialog";
import { playPcm16, startRecording, type Recorder } from "./lib/audio";
import { embedDocument } from "./lib/embed";
import { type Content, listModels, type ModelInfo, streamText, streamTextWithTools, synthesizeSpeech, transcribeAudio } from "./lib/gemini";
import { LiveSession, type LiveState } from "./lib/liveSession";
import { buildRecentContext, retrieveContext } from "./lib/recall";
import { MEMORY_PERSONA, RECALL_MEMORY_DECLARATION, runRecallTool } from "./lib/recallTool";
import { extractAndSyncProfile, type Fact, getProfile, renderProfileBlock } from "./lib/profile";
import { store } from "./lib/store";
import { currentTimeContext } from "./lib/time";
import { recordTurn, type TurnItem } from "./recordApi";
import { useVisualViewport } from "./useVisualViewport";
import type { Me } from "./authApi";
import type { ChatMessage } from "./types";

const uid = () => crypto.randomUUID();
const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

function toContents(msgs: ChatMessage[]): Content[] {
  return msgs
    .filter((m) => m.text && !m.error)
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.text }],
    }));
}

export default function Chat({ user, onLogout }: { user: Me; onLogout: () => void }) {
  // Keep the shell sized to the visible viewport so the composer rides above the keyboard.
  useVisualViewport();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [textModel, setTextModel] = useState(store.getTextModel());
  const [audioModel, setAudioModel] = useState(store.getAudioModel());
  const [liveModel, setLiveModel] = useState(store.getLiveModel());
  const [voice, setVoice] = useState(store.getVoice());
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const recorderRef = useRef<Recorder | null>(null);

  // Realtime voice call (Live API)
  const [callState, setCallState] = useState<LiveState | null>(null);
  const [callMuted, setCallMuted] = useState(false);
  const [callError, setCallError] = useState("");
  // ms timestamp of when the current call connected (null until connected / when no call is active).
  // Drives the live mm:ss timer in the CallBar; the ref mirror lets the end/close handlers read it
  // without a stale closure when they log the call duration into chat history.
  const [callStartedAt, setCallStartedAtState] = useState<number | null>(null);
  const callStartedAtRef = useRef<number | null>(null);
  const setCallStartedAt = useCallback((v: number | null) => {
    callStartedAtRef.current = v;
    setCallStartedAtState(v);
  }, []);
  const liveRef = useRef<LiveSession | null>(null);
  const liveUserIdRef = useRef<string | null>(null);
  const liveAsstIdRef = useRef<string | null>(null);
  const liveUserTextRef = useRef("");
  const liveAsstTextRef = useRef("");

  // Memory (recall)
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const [memoryOn] = useState(true);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const conversationIdRef = useRef(uid());

  // Derived profile ("what the AI knows about you"): loaded once, injected into every chat, and
  // refreshed after each extraction. Refs (+ store getters) so the unload/idle handlers see live state.
  const profileFactsRef = useRef<Fact[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  const extractCursorRef = useRef(0); // messages already distilled into the profile this conversation
  const extractTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const refreshProfile = useCallback(async () => {
    if (!store.getMemoryOn() || !store.getKey()) return;
    profileFactsRef.current = await getProfile();
  }, []);

  // Distil new turns into the profile (fire-and-forget; never blocks chat). `minNew` guards against
  // extracting tiny fragments — a closing conversation needs one exchange, an idle tick needs more.
  const runExtraction = useCallback(async (minNew = 2) => {
    if (!store.getMemoryOn() || !store.getKey()) return;
    const transcript = messagesRef.current
      .filter((m) => m.text && !m.error && !m.streaming)
      .map((m) => ({ role: m.role, text: m.text }));
    if (transcript.length - extractCursorRef.current < minNew) return;
    extractCursorRef.current = transcript.length;
    const delta = await extractAndSyncProfile({
      model: store.getTextModel(),
      conversationId: conversationIdRef.current,
      currentFacts: profileFactsRef.current,
      transcript,
    });
    if (delta) await refreshProfile();
  }, [refreshProfile]);

  const scheduleExtraction = useCallback(() => {
    if (extractTimerRef.current) clearTimeout(extractTimerRef.current);
    extractTimerRef.current = setTimeout(() => void runExtraction(4), 20000);
  }, [runExtraction]);

  const loadModels = useCallback(async (key: string) => {
    if (!key) return;
    setModelsLoading(true);
    setModelsError("");
    try {
      setModels(await listModels(key));
    } catch (e) {
      setModels(null);
      setModelsError(errMsg(e));
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    const k = store.getKey();
    setApiKey(k);
    if (k) void loadModels(k);
    else setDrawerOpen(true);
    store.setMemoryOn(true); // memory is always on; keep the persisted guard in sync
    setNoticeOpen(!store.getNoticeSeen());
    void refreshProfile();
  }, [loadModels, refreshProfile]);

  // Distil the conversation when the user backgrounds or leaves the tab — a natural "conversation end".
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void runExtraction(2);
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
      if (extractTimerRef.current) clearTimeout(extractTimerRef.current);
    };
  }, [runExtraction]);

  function dismissNotice() {
    store.setNoticeSeen();
    setNoticeOpen(false);
  }

  function saveKey(k: string) {
    store.setKey(k);
    setApiKey(k);
    if (k) void loadModels(k);
  }
  function clearKey() {
    store.setKey("");
    setApiKey("");
    setModels(null);
    setModelsError("");
  }
  function pickTextModel(v: string) {
    store.setTextModel(v);
    setTextModel(v);
  }
  function pickAudioModel(v: string) {
    store.setAudioModel(v);
    setAudioModel(v);
  }
  function pickLiveModel(v: string) {
    store.setLiveModel(v);
    setLiveModel(v);
  }
  function pickVoice(v: string) {
    store.setVoice(v);
    setVoice(v);
  }

  async function runAssistant(asstId: string, contents: Content[], speak: boolean): Promise<string> {
    let acc = "";
    const onDelta = (delta: string) => {
      acc += delta;
      setMessages((cur) => cur.map((m) => (m.id === asstId ? { ...m, text: acc } : m)));
    };
    // System instruction always carries the current local time. When memory is on, also give the
    // model the memory persona + the recall_memory tool so it can search past chats on demand
    // (covers text + push-to-talk) instead of denying it has any memory.
    if (memoryOn) {
      // Ground the reply in the durable profile (who the user is) + persona + current time.
      const sys = [renderProfileBlock(profileFactsRef.current), MEMORY_PERSONA, currentTimeContext()]
        .filter(Boolean)
        .join("\n\n");
      const tools = [{ functionDeclarations: [RECALL_MEMORY_DECLARATION] }];
      for await (const delta of streamTextWithTools(apiKey, textModel, contents, sys, tools, (_name, args) => runRecallTool(args))) {
        onDelta(delta);
      }
    } else {
      for await (const delta of streamText(apiKey, textModel, contents, currentTimeContext())) {
        onDelta(delta);
      }
    }
    const finalText = acc || "_(no response)_";
    setMessages((cur) => cur.map((m) => (m.id === asstId ? { ...m, streaming: false, text: finalText } : m)));
    if (speak && acc) {
      try {
        const audio = await synthesizeSpeech(apiKey, audioModel, acc, voice);
        setMessages((cur) => cur.map((m) => (m.id === asstId ? { ...m, audio } : m)));
        void playPcm16(audio.base64, audio.sampleRate);
      } catch {
        /* TTS is best-effort; the text reply still stands */
      }
    }
    return acc;
  }

  // --- Memory: record finished turns + pull relevant memories into context (RAG) ---

  async function recordTextTurns(items: { role: "user" | "assistant"; text: string; modality: "text" | "voice" | "live" }[], extra?: { audioBase64?: string }) {
    if (!memoryOn) return;
    const turns: TurnItem[] = [];
    for (const it of items) {
      if (!it.text.trim() && !(it.role === "user" && extra?.audioBase64)) continue;
      const embedding = it.text.trim() ? (await embedDocument(it.text)) ?? undefined : undefined;
      turns.push({
        role: it.role,
        modality: it.modality,
        text: it.text,
        embedding,
        ...(it.role === "user" && extra?.audioBase64 ? { audioBase64: extra.audioBase64, audioMime: "audio/wav" } : {}),
      });
    }
    recordTurn(conversationIdRef.current, turns);
    scheduleExtraction(); // distil durable facts a little after the conversation goes idle
  }

  /** Relevant past context (episodic summaries + turns, re-ranked) as a preface for the next reply. */
  async function ragPreface(query: string): Promise<Content | null> {
    if (!memoryOn) return null;
    const recent = messages.filter((m) => m.text && !m.error).map((m) => ({ role: m.role, text: m.text }));
    return retrieveContext({
      recent,
      currentText: query,
      profileBlock: renderProfileBlock(profileFactsRef.current),
      nowMs: Date.now(),
    });
  }

  async function sendText(text: string) {
    if (!apiKey) {
      setDrawerOpen(true);
      return;
    }
    const userMsg: ChatMessage = { id: uid(), role: "user", text, kind: "text" };
    const asstId = uid();
    const base = [...messages, userMsg];
    setMessages([...base, { id: asstId, role: "assistant", text: "", streaming: true }]);
    setStreaming(true);
    try {
      const preface = await ragPreface(text);
      const contents = preface ? [preface, ...toContents(base)] : toContents(base);
      const reply = await runAssistant(asstId, contents, false);
      void recordTextTurns([
        { role: "user", text, modality: "text" },
        { role: "assistant", text: reply, modality: "text" },
      ]);
    } catch (e) {
      setMessages((cur) =>
        cur.map((m) => (m.id === asstId ? { ...m, streaming: false, error: true, text: errMsg(e) } : m)),
      );
    } finally {
      setStreaming(false);
    }
  }

  async function startVoice() {
    if (!apiKey) {
      setDrawerOpen(true);
      return;
    }
    try {
      recorderRef.current = await startRecording();
      setVoiceState("recording");
    } catch {
      setVoiceState("idle");
      setMessages((cur) => [
        ...cur,
        { id: uid(), role: "assistant", text: "Microphone access was blocked. Allow it in your browser to use voice.", error: true },
      ]);
    }
  }

  async function stopVoice() {
    const rec = recorderRef.current;
    if (!rec) return;
    recorderRef.current = null;
    setVoiceState("processing");
    setStreaming(true);
    const userMsg: ChatMessage = { id: uid(), role: "user", text: "", kind: "voice" };
    const asstId = uid();
    try {
      const { base64, mimeType } = await rec.stop();
      const base = [...messages, userMsg];
      setMessages([...base, { id: asstId, role: "assistant", text: "", streaming: true, kind: "voice" }]);
      // Transcribe in parallel with the reply (a second, audio-capable generateContent call). Fills the
      // user's bubble in place when it lands; an empty/failed transcript degrades to the "Voice message"
      // label so the turn still reads sensibly and stays in toContents() history.
      const transcriptPromise = transcribeAudio(apiKey, textModel, base64, mimeType)
        .then((t) => {
          setMessages((cur) => cur.map((m) => (m.id === userMsg.id ? { ...m, text: t || "Voice message" } : m)));
          return t;
        })
        .catch(() => "");
      const contents: Content[] = [
        ...toContents(messages),
        {
          role: "user",
          parts: [{ inlineData: { mimeType, data: base64 } }, { text: "Respond conversationally to this voice message." }],
        },
      ];
      const reply = await runAssistant(asstId, contents, true);
      // Record the user's spoken audio file + its transcript, plus the assistant's reply text.
      const transcript = await transcriptPromise; // already resolved in practice; never throws
      void recordTextTurns(
        [
          { role: "user", text: transcript || "(voice message)", modality: "voice" },
          { role: "assistant", text: reply, modality: "voice" },
        ],
        { audioBase64: base64 },
      );
    } catch (e) {
      setMessages((cur) => {
        const errored: ChatMessage = { id: asstId, role: "assistant", text: errMsg(e), streaming: false, error: true };
        return cur.some((m) => m.id === asstId) ? cur.map((m) => (m.id === asstId ? errored : m)) : [...cur, errored];
      });
    } finally {
      setVoiceState("idle");
      setStreaming(false);
    }
  }

  function playAudio(m: ChatMessage) {
    if (m.audio) void playPcm16(m.audio.base64, m.audio.sampleRate);
  }

  // --- Realtime voice call (Live API) ---

  function appendLiveText(role: "user" | "assistant", delta: string) {
    const ref = role === "user" ? liveUserIdRef : liveAsstIdRef;
    const txtRef = role === "user" ? liveUserTextRef : liveAsstTextRef;
    txtRef.current += delta;
    setMessages((cur) => {
      if (ref.current) return cur.map((m) => (m.id === ref.current ? { ...m, text: m.text + delta } : m));
      const id = uid();
      ref.current = id;
      return [...cur, { id, role, text: delta }];
    });
  }

  // Log a "call ended" summary chip into chat history with how long the call lasted. Idempotent:
  // reads + clears the start time, so the manual-End and server-close paths can both call it safely
  // (the second call sees a null start and no-ops). Calls that never connected leave no chip.
  function finishCall() {
    const startedAt = callStartedAtRef.current;
    setCallStartedAt(null);
    if (startedAt == null) return;
    // Floor (not round) to match the live CallBar timer, which floors — so the chip never reads a
    // second more than the last value the user watched tick, and sub-1s blips stay suppressed.
    const durationSec = Math.floor((Date.now() - startedAt) / 1000);
    if (durationSec < 1) return;
    setMessages((cur) => [...cur, { id: uid(), role: "assistant", text: "", kind: "call", durationSec }]);
  }

  async function startCall() {
    if (!apiKey) {
      setDrawerOpen(true);
      return;
    }
    setCallError("");
    setCallMuted(false);
    setCallStartedAt(null);
    liveUserIdRef.current = null;
    liveAsstIdRef.current = null;
    liveUserTextRef.current = "";
    liveAsstTextRef.current = "";
    const profileBlock = memoryOn ? renderProfileBlock(profileFactsRef.current) ?? undefined : undefined;
    const recentContext = memoryOn ? (await buildRecentContext()) ?? undefined : undefined;
    const session = new LiveSession(apiKey, liveModel, voice, memoryOn, profileBlock, recentContext);
    liveRef.current = session;
    setCallState("connecting");
    try {
      await session.start({
        onState: (s) => {
          setCallState(s);
          // Start the clock the moment audio first flows (first connected state), so the recorded
          // duration is the time actually spent talking — not the connecting handshake.
          if ((s === "listening" || s === "speaking") && callStartedAtRef.current == null) {
            setCallStartedAt(Date.now());
          }
        },
        onUserText: (d) => appendLiveText("user", d),
        onModelText: (d) => appendLiveText("assistant", d),
        onTurnComplete: () => {
          // Record the just-finished spoken turn as transcripts (live audio capture is a fast-follow).
          void recordTextTurns([
            { role: "user", text: liveUserTextRef.current, modality: "live" },
            { role: "assistant", text: liveAsstTextRef.current, modality: "live" },
          ]);
          liveUserIdRef.current = null;
          liveAsstIdRef.current = null;
          liveUserTextRef.current = "";
          liveAsstTextRef.current = "";
        },
        onError: setCallError,
      });
    } catch (e) {
      setCallError(errMsg(e));
      setCallState("error");
    }
  }

  async function endCall() {
    const s = liveRef.current;
    liveRef.current = null;
    finishCall();
    await s?.stop();
    setCallState(null);
  }

  function toggleMute() {
    setCallMuted((m) => {
      const next = !m;
      liveRef.current?.setMuted(next);
      return next;
    });
  }

  useEffect(() => () => void liveRef.current?.stop(), []);

  // If the call ends on its own (server/network drop) rather than via the End button, the session's
  // onclose/onerror surfaces "closed"/"error" without stop() ever running. Release the mic/loopback
  // so they don't keep capturing, and auto-dismiss a cleanly-closed bar so it doesn't linger over
  // the chat. An errored bar stays until the user dismisses it (so they can read the message).
  useEffect(() => {
    if (callState !== "closed" && callState !== "error") return;
    void liveRef.current?.stop();
    liveRef.current = null;
    finishCall(); // log the duration once; no-ops if End already handled it or the call never connected
    if (callState === "closed") {
      const t = setTimeout(() => setCallState(null), 1500);
      return () => clearTimeout(t);
    }
    // finishCall reads a ref and is safe to omit from deps; rerunning only on callState is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callState]);

  return (
    <div className="app-shell flex flex-row bg-linear-to-b from-black/2 to-transparent dark:from-white/5">
      <Sidebar
        user={user}
        textModel={textModel}
        onNewChat={() => {
          if (callState) void endCall(); // tear down any live call so its mic/transcript don't leak into the new chat
          void runExtraction(2); // distil the conversation we're leaving before clearing it
          setMessages([]);
          conversationIdRef.current = uid();
          extractCursorRef.current = 0;
        }}
        onOpenMemories={() => setMemoryPanelOpen(true)}
        onOpenSettings={() => setDrawerOpen(true)}
        onSignOut={() => setConfirmLogout(true)}
        open={navOpen}
        onClose={() => setNavOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-black/10 bg-white/80 px-4 py-3 backdrop-blur md:hidden dark:border-white/10 dark:bg-neutral-950/80">
          <button
            onClick={() => setNavOpen(true)}
            title="Menu"
            aria-label="Open menu"
            className="-ml-2 rounded-md p-2 text-black/60 transition hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
          >
            <Menu size={18} />
          </button>
          <MessageCircle size={18} className="shrink-0" aria-hidden="true" />
          <span className="font-semibold">EverVault</span>
        </header>

        {noticeOpen && (
          <div className="border-b border-black/10 bg-blue-50 dark:border-white/10 dark:bg-blue-950/30">
            <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-2 text-xs text-blue-800 dark:text-blue-200">
              <span className="flex-1">
                Your chats are saved so you (and the AI) can recall them later. Manage them in{" "}
                <button onClick={() => setMemoryPanelOpen(true)} className="font-medium underline">
                  Memories
                </button>
                .
              </span>
              <button onClick={dismissNotice} className="rounded p-1 hover:bg-blue-100 dark:hover:bg-blue-900/40" aria-label="Dismiss">
                <X size={14} />
              </button>
            </div>
          </div>
        )}

        <main className="flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-4 py-20 text-center">
              <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-linear-to-br from-blue-500 to-violet-500 shadow-md">
                <Sparkles className="h-8 w-8 text-white" aria-hidden="true" />
              </div>
              <h1 className="inline-flex items-center gap-2 text-2xl font-semibold">
                Hi {user.name?.split(" ")[0] || "there"}
                <Hand className="h-6 w-6 text-amber-500" aria-hidden="true" />
              </h1>
              <p className="mt-2 max-w-md text-sm text-black/55 dark:text-white/55">
                Ask anything by text, or tap the mic to talk. Replies can be spoken back to you.
              </p>
              {!apiKey && (
                <button
                  onClick={() => setDrawerOpen(true)}
                  className="mt-6 rounded-full bg-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700"
                >
                  Add your Gemini key to start
                </button>
              )}
            </div>
          ) : (
            <MessageList
              messages={messages}
              userName={user.name}
              userPicture={user.picture}
              onPlayAudio={playAudio}
              scrollSignal={!!callState}
            />
          )}
        </main>

        {callState && (
          <CallBar
            state={callState}
            muted={callMuted}
            error={callError}
            startedAt={callStartedAt}
            onToggleMute={toggleMute}
            onEnd={endCall}
          />
        )}

        <Composer
          onSendText={sendText}
          onStartVoice={startVoice}
          onStopVoice={stopVoice}
          onStartCall={startCall}
          voiceState={voiceState}
          disabled={streaming}
          hasKey={!!apiKey}
          inCall={!!callState}
          onNeedKey={() => setDrawerOpen(true)}
        />
      </div>

      <KeyDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        apiKey={apiKey}
        onSaveKey={saveKey}
        onClearKey={clearKey}
        models={models}
        modelsLoading={modelsLoading}
        modelsError={modelsError}
        onReloadModels={() => loadModels(apiKey)}
        textModel={textModel}
        audioModel={audioModel}
        liveModel={liveModel}
        voice={voice}
        onChangeTextModel={pickTextModel}
        onChangeAudioModel={pickAudioModel}
        onChangeLiveModel={pickLiveModel}
        onChangeVoice={pickVoice}
      />

      <MemoryPanel
        open={memoryPanelOpen}
        onClose={() => setMemoryPanelOpen(false)}
        memoryOn={memoryOn}
      />

      <ConfirmDialog
        open={confirmLogout}
        title="Sign out?"
        message="You’ll need to sign in again to continue chatting."
        confirmLabel="Sign out"
        confirmVariant="danger"
        onClose={() => setConfirmLogout(false)}
        onConfirm={() => {
          setConfirmLogout(false);
          onLogout();
        }}
      />
    </div>
  );
}
