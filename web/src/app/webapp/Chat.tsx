"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LogOut, Settings2, SquarePen } from "lucide-react";
import Composer, { type VoiceState } from "./Composer";
import KeyDrawer from "./KeyDrawer";
import MessageList from "./MessageList";
import { playPcm16, startRecording, type Recorder } from "./lib/audio";
import { type Content, listModels, type ModelInfo, streamText, synthesizeSpeech } from "./lib/gemini";
import { store } from "./lib/store";
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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [textModel, setTextModel] = useState(store.getTextModel());
  const [audioModel, setAudioModel] = useState(store.getAudioModel());
  const [voice, setVoice] = useState(store.getVoice());
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const recorderRef = useRef<Recorder | null>(null);

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
  }, [loadModels]);

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
  function pickVoice(v: string) {
    store.setVoice(v);
    setVoice(v);
  }

  async function runAssistant(asstId: string, contents: Content[], speak: boolean) {
    let acc = "";
    for await (const delta of streamText(apiKey, textModel, contents)) {
      acc += delta;
      setMessages((cur) => cur.map((m) => (m.id === asstId ? { ...m, text: acc } : m)));
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
      await runAssistant(asstId, toContents(base), false);
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
    const userMsg: ChatMessage = { id: uid(), role: "user", text: "🎤", kind: "voice" };
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
      await runAssistant(asstId, contents, true);
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

  return (
    <div className="flex h-screen flex-col bg-linear-to-b from-black/2 to-transparent dark:from-white/5">
      <header className="sticky top-0 z-10 border-b border-black/10 bg-white/80 backdrop-blur dark:border-white/10 dark:bg-neutral-950/80">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-lg">💬</span>
            <span className="font-semibold">EverVault</span>
            <span className="truncate text-xs text-black/40 dark:text-white/40">· {textModel}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setMessages([])}
              title="New chat"
              className="rounded-md p-2 text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
            >
              <SquarePen size={18} />
            </button>
            <button
              onClick={() => setDrawerOpen(true)}
              title="Settings"
              className="rounded-md p-2 text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
            >
              <Settings2 size={18} />
            </button>
            <button
              onClick={onLogout}
              title="Sign out"
              className="rounded-md p-2 text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
            >
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-4 py-20 text-center">
            <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-linear-to-br from-blue-500 to-violet-500 text-3xl shadow-md">
              ✨
            </div>
            <h1 className="text-2xl font-semibold">Hi {user.name?.split(" ")[0] || "there"} 👋</h1>
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
          <MessageList messages={messages} userName={user.name} userPicture={user.picture} onPlayAudio={playAudio} />
        )}
      </main>

      <Composer
        onSendText={sendText}
        onStartVoice={startVoice}
        onStopVoice={stopVoice}
        voiceState={voiceState}
        disabled={streaming}
        hasKey={!!apiKey}
        onNeedKey={() => setDrawerOpen(true)}
      />

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
        voice={voice}
        onChangeTextModel={pickTextModel}
        onChangeAudioModel={pickAudioModel}
        onChangeVoice={pickVoice}
      />
    </div>
  );
}
