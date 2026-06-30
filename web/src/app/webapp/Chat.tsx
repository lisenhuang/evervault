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
import { embedDocument, embedQuery } from "./lib/embed";
import { type Content, listModels, type ModelInfo, streamText, streamTextWithTools, synthesizeSpeech } from "./lib/gemini";
import { LiveSession, type LiveState } from "./lib/liveSession";
import { MEMORY_PERSONA, RECALL_MEMORY_DECLARATION, runRecallTool } from "./lib/recallTool";
import { store } from "./lib/store";
import { currentTimeContext, formatMemoryDate } from "./lib/time";
import { recordTurn, searchMemories, type TurnItem } from "./recordApi";
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
  const liveRef = useRef<LiveSession | null>(null);
  const liveUserIdRef = useRef<string | null>(null);
  const liveAsstIdRef = useRef<string | null>(null);
  const liveUserTextRef = useRef("");
  const liveAsstTextRef = useRef("");

  // Memory (recall)
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const [memoryOn, setMemoryOn] = useState(true);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const conversationIdRef = useRef(uid());

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
    setMemoryOn(store.getMemoryOn());
    setNoticeOpen(!store.getNoticeSeen());
  }, [loadModels]);

  function toggleMemory(on: boolean) {
    store.setMemoryOn(on);
    setMemoryOn(on);
  }
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
      const sys = `${MEMORY_PERSONA}\n${currentTimeContext()}`;
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
  }

  /** Top relevant past memories as a context preface for the next reply, or null. */
  async function ragPreface(query: string): Promise<Content | null> {
    if (!memoryOn) return null;
    const qv = await embedQuery(query);
    if (!qv) return null; // no key/policy → no auto-recall
    const hits = await searchMemories(qv, query, 5);
    const relevant = hits.filter((h) => h.distance == null || h.distance < 0.6).slice(0, 5);
    if (relevant.length === 0) return null;
    const text =
      "Context — things this user shared with you earlier (use only if relevant, don't mention this note):\n" +
      relevant.map((h) => `- (${formatMemoryDate(h.createdAt)}) ${h.content}`).join("\n");
    return { role: "user", parts: [{ text }] };
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
    const userMsg: ChatMessage = { id: uid(), role: "user", text: "Voice message", kind: "voice" };
    const asstId = uid();
    try {
      const { base64, mimeType } = await rec.stop();
      const base = [...messages, userMsg];
      setMessages([...base, { id: asstId, role: "assistant", text: "", streaming: true, kind: "voice" }]);
      const contents: Content[] = [
        ...toContents(messages),
        {
          role: "user",
          parts: [{ inlineData: { mimeType, data: base64 } }, { text: "Respond conversationally to this voice message." }],
        },
      ];
      const reply = await runAssistant(asstId, contents, true);
      // Record the user's spoken audio file + the assistant's reply text (user audio has no transcript).
      void recordTextTurns(
        [
          { role: "user", text: "(voice message)", modality: "voice" },
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

  async function startCall() {
    if (!apiKey) {
      setDrawerOpen(true);
      return;
    }
    setCallError("");
    setCallMuted(false);
    liveUserIdRef.current = null;
    liveAsstIdRef.current = null;
    liveUserTextRef.current = "";
    liveAsstTextRef.current = "";
    const session = new LiveSession(apiKey, liveModel, voice, memoryOn);
    liveRef.current = session;
    setCallState("connecting");
    try {
      await session.start({
        onState: setCallState,
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
    if (callState === "closed") {
      const t = setTimeout(() => setCallState(null), 1500);
      return () => clearTimeout(t);
    }
  }, [callState]);

  return (
    <div className="app-shell flex flex-row bg-linear-to-b from-black/2 to-transparent dark:from-white/5">
      <Sidebar
        user={user}
        textModel={textModel}
        onNewChat={() => {
          setMessages([]);
          conversationIdRef.current = uid();
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
                Your chats are saved so you (and the AI) can recall them later. Manage or turn this off in{" "}
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
        onToggleMemory={toggleMemory}
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
