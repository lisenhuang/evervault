"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Hand, Menu, MessageCircle, Sparkles } from "lucide-react";
import Sidebar from "./Sidebar";
import CallBar from "./CallBar";
import CallEndedModal from "./CallEndedModal";
import Composer, { type VoiceState } from "./Composer";
import KeyDrawer from "./KeyDrawer";
import MessageList from "./MessageList";
import ConfirmDialog from "@/components/ConfirmDialog";
import { playPcm16Handle, startRecording, type Recorder } from "./lib/audio";
import { embedDocument } from "./lib/embed";
import { type Content, describeDocument, describeImage, listModels, type ModelInfo, streamText, streamTextWithTools, synthesizeSpeech, transcribeAudio } from "./lib/gemini";
import type { PreparedFile } from "./lib/files";
import { LiveSession, type LiveState } from "./lib/liveSession";
import { buildRecentContext, retrieveContext } from "./lib/recall";
import { CAPABILITY_BOUNDS } from "./lib/persona";
import { MEMORY_PERSONA, RECALL_MEMORY_DECLARATION, runRecallTool } from "./lib/recallTool";
import { isTaskTool, runTaskTool, TASK_TOOL_DECLARATIONS, TASKS_PERSONA } from "./lib/taskTools";
import { extractAndSyncProfile, type Fact, getProfile, renderProfileBlock } from "./lib/profile";
import { getTasks, renderAgendaBlock, type Task } from "./lib/tasks";
import { store } from "./lib/store";
import { currentTimeContext } from "./lib/time";
import { recordTurn, type TurnItem } from "./recordApi";
import { useVisualViewport } from "./useVisualViewport";
import { api, type Me } from "./authApi";
import type { ChatMessage, ReplyRef } from "./types";
import { useLang } from "@/i18n/LanguageProvider";
import { aiReplyDirective } from "@/i18n/config";

const uid = () => crypto.randomUUID();
const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

// One attachment as a Gemini part: images/PDFs go inline; extracted documents go as delimited text.
function fileToPart(f: PreparedFile) {
  if (f.kind === "text") {
    return { text: `--- Attached file: ${f.name} ---\n${f.text ?? ""}\n--- End of file: ${f.name} ---` };
  }
  return { inlineData: { mimeType: f.mimeType, data: f.base64 ?? "" } };
}

// Human-readable file-type label for the memory note, so a recalled attachment reads as "the user
// sent an audio file" rather than a bare transcript the model might mistake for pasted text.
const FILE_KIND_LABEL: Record<PreparedFile["kind"], string> = {
  image: "an image",
  audio: "an audio file",
  pdf: "a PDF document",
  text: "a file",
};

// How much of one file's extracted content (transcript / description / text) to fold into the memory
// note. The whole thing is embedded + stored, so keep each attachment's contribution bounded.
const MEMORY_CONTENT_MAX = 4000;

function clipMemory(text: string): string {
  return text.length <= MEMORY_CONTENT_MAX ? text : `${text.slice(0, MEMORY_CONTENT_MAX)}…`;
}

/**
 * A durable memory line for one attached file. Always records the fact that the user *sent* a file
 * (its type + name) so it's recalled as an attachment even when the content extraction is empty, then
 * appends whatever content we can recover: image description, audio transcript, extracted text, or a
 * PDF summary. Best-effort — a failed extraction still leaves the "user sent X" record.
 */
async function fileMemoryLine(apiKey: string, model: string, f: PreparedFile): Promise<string> {
  const header = `[The user sent ${FILE_KIND_LABEL[f.kind]} named "${f.name}"]`;
  if (f.kind === "image" && f.base64) {
    const desc = await describeImage(apiKey, model, f.base64, f.mimeType).catch(() => "");
    return desc ? `${header} It shows: ${clipMemory(desc)}` : header;
  }
  if (f.kind === "audio" && f.base64) {
    const tx = await transcribeAudio(apiKey, model, f.base64, f.mimeType).catch(() => "");
    return tx ? `${header} Transcript of the audio: ${clipMemory(tx)}` : header;
  }
  if (f.kind === "pdf" && f.base64) {
    const desc = await describeDocument(apiKey, model, f.base64, f.mimeType).catch(() => "");
    return desc ? `${header} Document contents: ${clipMemory(desc)}` : header;
  }
  if (f.kind === "text" && f.text) {
    return `${header} File contents: ${clipMemory(f.text)}`;
  }
  return header;
}

// Cap for the quoted snippet woven into the model prompt — enough to identify the message
// without replaying a whole essay twice in the context.
const REPLY_SNIPPET_MAX = 300;

/** Plain-text marker telling the model which earlier message this one replies to. */
function replyContext(r: ReplyRef): string {
  const who = r.role === "assistant" ? "your (the assistant's) earlier message" : "the user's own earlier message";
  const snippet = (r.text || "(voice message)").slice(0, REPLY_SNIPPET_MAX);
  return `[This message is a direct reply to ${who}: "${snippet}"]`;
}

function toContents(msgs: ChatMessage[]): Content[] {
  return msgs
    .filter((m) => (m.text || m.files?.length) && !m.error)
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      // Replay attached files inline so follow-up questions about a picture/document keep working.
      parts: [
        // The quoted-message marker precedes the text so the model reads the reply in context.
        ...(m.replyTo ? [{ text: replyContext(m.replyTo) }] : []),
        ...(m.files ?? []).map(fileToPart),
        ...(m.text ? [{ text: m.text }] : []),
      ],
    }));
}

export default function Chat({ user, onLogout }: { user: Me; onLogout: () => void }) {
  // Keep the shell sized to the visible viewport so the composer rides above the keyboard.
  useVisualViewport();
  const { t, lang } = useLang();

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
  const [confirmDeleteAccount, setConfirmDeleteAccount] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteAccountError, setDeleteAccountError] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  // Message the next send will quote — set from a bubble's context menu (right-click / long-press).
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  // Only one spoken reply plays at a time — starting another (auto-play or a manual "Play reply"
  // click) stops whatever is currently playing first.
  const playingAudioRef = useRef<{ stop: () => void; pause: () => void; resume: () => void } | null>(null);
  // Which reply's audio is loaded in the player and whether it's paused — drives the bubble's play
  // button (animated while playing, "resume" while paused). null when nothing is loaded.
  const [audioPlaying, setAudioPlaying] = useState<{ id: string; paused: boolean } | null>(null);
  const playAudioClip = useCallback((id: string, base64: string, sampleRate: number) => {
    playingAudioRef.current?.stop();
    const handle = playPcm16Handle(base64, sampleRate);
    playingAudioRef.current = handle;
    setAudioPlaying({ id, paused: false });
    void handle.ended.then(() => {
      if (playingAudioRef.current === handle) {
        playingAudioRef.current = null;
        setAudioPlaying(null);
      }
    });
  }, []);

  // Realtime voice call (Live API)
  const [callState, setCallState] = useState<LiveState | null>(null);
  const [callMuted, setCallMuted] = useState(false);
  const [callError, setCallError] = useState("");
  // The call auto-hung-up because the user went silent too long (fell asleep / walked away). Drives
  // the CallBar's closing message so the end reads as an intentional idle timeout, not a dropped call.
  const [callIdleClosed, setCallIdleClosed] = useState(false);
  // The idle-timeout modal is open: the call auto-ended on a long silence, so we surface an
  // explanatory dialog with a one-tap Reconnect instead of just letting the bar vanish.
  const [idleEndedOpen, setIdleEndedOpen] = useState(false);
  // Echo-prone output path (iOS speaker, or the loopback failed): the session runs half duplex —
  // the mic is gated while the model speaks, so interrupting is by tap instead of by voice. The
  // headphones toggle (persisted) lifts the gate, since headphones produce no acoustic echo.
  const [callEchoProne, setCallEchoProne] = useState(false);
  const [callHalfDuplex, setCallHalfDuplex] = useState(false);
  const [callHeadphones, setCallHeadphones] = useState(
    () => typeof window !== "undefined" && localStorage.getItem("voice:headphones") === "1",
  );
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

  // Memory (recall) — background RAG only; the user-facing Memories panel is not exposed.
  const [memoryOn] = useState(true);
  const conversationIdRef = useRef(uid());

  // Derived profile ("what the AI knows about you"): loaded once, injected into every chat, and
  // refreshed after each extraction. Refs (+ store getters) so the unload/idle handlers see live state.
  const profileFactsRef = useRef<Fact[]>([]);
  const tasksRef = useRef<Task[]>([]);
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

  const refreshTasks = useCallback(async () => {
    if (!store.getMemoryOn() || !store.getKey()) return;
    tasksRef.current = await getTasks("open");
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
      currentTasks: tasksRef.current,
      transcript,
    });
    if (delta?.profileChanged) await refreshProfile();
    if (delta?.tasksChanged) await refreshTasks();
  }, [refreshProfile, refreshTasks]);

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
    void refreshProfile();
    void refreshTasks();
  }, [loadModels, refreshProfile, refreshTasks]);

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
    // System instruction always carries the current local time + the reply-language directive (so the
    // assistant answers in the selected UI language). When memory is on, also give the model the
    // memory persona + the recall_memory tool so it can search past chats on demand (covers text +
    // push-to-talk) instead of denying it has any memory.
    const langDirective = aiReplyDirective(lang);
    if (memoryOn) {
      // Ground the reply in the durable profile (who the user is) + today's task agenda + persona +
      // current time. The agenda is re-rendered every turn, so task tool calls show up mid-conversation.
      const sys = [
        renderProfileBlock(profileFactsRef.current),
        renderAgendaBlock(tasksRef.current),
        langDirective,
        CAPABILITY_BOUNDS,
        MEMORY_PERSONA,
        TASKS_PERSONA,
        currentTimeContext(),
      ]
        .filter(Boolean)
        .join("\n\n");
      const tools = [{ functionDeclarations: [RECALL_MEMORY_DECLARATION, ...TASK_TOOL_DECLARATIONS] }];
      const runTool = (name: string, args: Record<string, unknown>) =>
        isTaskTool(name) ? runTaskTool(name, args, () => void refreshTasks()) : runRecallTool(args);
      for await (const delta of streamTextWithTools(apiKey, textModel, contents, sys, tools, runTool)) {
        onDelta(delta);
      }
    } else {
      const sys = [langDirective, CAPABILITY_BOUNDS, currentTimeContext()].filter(Boolean).join("\n\n");
      for await (const delta of streamText(apiKey, textModel, contents, sys)) {
        onDelta(delta);
      }
    }
    const finalText = acc || "_(no response)_";
    if (speak && acc) {
      // Voice reply: hold the text behind the "typing" dots (the placeholder carries pendingAudio)
      // until the spoken audio is ready, then reveal the text and auto-play — so the reply lands as
      // text + voice together instead of the text racing ahead of the slower TTS. We keep the message
      // flagged (streaming + pendingAudio) so the bubble stays on the dots while synthesis runs; the
      // caller's busy state settles immediately, so the composer stays usable in the meantime.
      setMessages((cur) => cur.map((m) => (m.id === asstId ? { ...m, text: finalText } : m)));
      void (async () => {
        try {
          const audio = await synthesizeSpeech(apiKey, audioModel, acc, voice);
          setMessages((cur) =>
            cur.map((m) => (m.id === asstId ? { ...m, streaming: false, pendingAudio: false, audio } : m)),
          );
          // Auto-play the moment the audio lands; the manual "Play reply" button stays for replay.
          playAudioClip(asstId, audio.base64, audio.sampleRate);
        } catch {
          // TTS failed — drop the hold so the text still appears (just without spoken audio).
          setMessages((cur) =>
            cur.map((m) => (m.id === asstId ? { ...m, streaming: false, pendingAudio: false } : m)),
          );
        }
      })();
    } else {
      setMessages((cur) =>
        cur.map((m) => (m.id === asstId ? { ...m, streaming: false, pendingAudio: false, text: finalText } : m)),
      );
    }
    return acc;
  }

  // --- Memory: record finished turns + pull relevant memories into context (RAG) ---

  async function recordTextTurns(
    items: { role: "user" | "assistant"; text: string; modality: "text" | "voice" | "live" | "image" }[],
    extra?: { audioBase64?: string; imageBase64?: string; imageMime?: string },
  ) {
    if (!memoryOn) return;
    const turns: TurnItem[] = [];
    for (const it of items) {
      if (!it.text.trim() && !(it.role === "user" && (extra?.audioBase64 || extra?.imageBase64))) continue;
      const embedding = it.text.trim() ? (await embedDocument(it.text)) ?? undefined : undefined;
      turns.push({
        role: it.role,
        modality: it.modality,
        text: it.text,
        embedding,
        ...(it.role === "user" && extra?.audioBase64 ? { audioBase64: extra.audioBase64, audioMime: "audio/wav" } : {}),
        ...(it.role === "user" && extra?.imageBase64
          ? { imageBase64: extra.imageBase64, imageMime: extra.imageMime || "image/jpeg" }
          : {}),
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

  async function sendText(text: string, files?: PreparedFile[]) {
    if (!apiKey) {
      setDrawerOpen(true);
      return;
    }
    const images = files?.filter((f) => f.kind === "image" && f.base64) ?? [];
    // Snapshot the quoted message (bounded — the quote renders two lines and the model sees a
    // capped snippet) and clear the composer's reply bar right away.
    const replyRef: ReplyRef | null = replyTo
      ? { id: replyTo.id, role: replyTo.role, text: replyTo.text.slice(0, 500) }
      : null;
    setReplyTo(null);
    const userMsg: ChatMessage = {
      id: uid(),
      role: "user",
      text,
      kind: images.length ? "image" : "text",
      ...(files?.length ? { files } : {}),
      ...(replyRef ? { replyTo: replyRef } : {}),
    };
    const asstId = uid();
    const base = [...messages, userMsg];
    setMessages([...base, { id: asstId, role: "assistant", text: "", streaming: true }]);
    setStreaming(true);
    try {
      const preface = await ragPreface(text);
      const contents = preface ? [preface, ...toContents(base)] : toContents(base);
      const reply = await runAssistant(asstId, contents, false);
      if (files?.length) {
        // Record the turn so past attachments can be recalled: each file becomes a memory line that
        // states the user *sent* a file (type + name) plus whatever content we can extract — image
        // description, audio transcript, PDF summary, or the file's text (a second generateContent
        // call per binary file). The first image itself also goes to R2. This way the AI always
        // remembers a file was sent and what it contained, even if it can't produce the file back.
        // Best-effort — never blocks the chat.
        void (async () => {
          const lines = await Promise.all(files.map((f) => fileMemoryLine(apiKey, textModel, f)));
          const userContent =
            [replyRef ? replyContext(replyRef) : "", text.trim(), ...lines].filter(Boolean).join("\n") ||
            "(attachment)";
          void recordTextTurns(
            [
              { role: "user", text: userContent, modality: images.length ? "image" : "text" },
              { role: "assistant", text: reply, modality: "text" },
            ],
            images[0] ? { imageBase64: images[0].base64, imageMime: images[0].mimeType } : undefined,
          );
        })();
      } else {
        void recordTextTurns([
          // Keep the quote in the recorded turn so recalled replies still read in context.
          { role: "user", text: replyRef ? `${replyContext(replyRef)}\n${text}` : text, modality: "text" },
          { role: "assistant", text: reply, modality: "text" },
        ]);
      }
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
        { id: uid(), role: "assistant", text: t.chat.micBlocked, error: true },
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
      // pendingAudio holds the reply's text behind the typing dots until its spoken audio is ready
      // (see runAssistant), so the text doesn't appear ahead of the slower voice.
      setMessages([...base, { id: asstId, role: "assistant", text: "", streaming: true, kind: "voice", pendingAudio: true }]);
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
      // Speak the reply too. TTS runs in the background (see runAssistant), so it doesn't hold the
      // composer's busy state — the voice button stays usable while the audio is being generated.
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
    if (!m.audio) return;
    const handle = playingAudioRef.current;
    // Same reply already loaded: toggle pause/resume so it continues from where it stopped.
    if (handle && audioPlaying && audioPlaying.id === m.id) {
      if (audioPlaying.paused) {
        handle.resume();
        setAudioPlaying({ id: m.id, paused: false });
      } else {
        handle.pause();
        setAudioPlaying({ id: m.id, paused: true });
      }
      return;
    }
    // A different reply (or nothing loaded): play it from the top.
    playAudioClip(m.id, m.audio.base64, m.audio.sampleRate);
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
      const msg: ChatMessage = { id, role, text: delta };
      // The Live API can deliver the user's input transcription after the model's reply has
      // already started streaming. Keep chat order = speaking order: this turn's user bubble
      // always sits above the assistant bubble that answers it.
      if (role === "user" && liveAsstIdRef.current) {
        const i = cur.findIndex((m) => m.id === liveAsstIdRef.current);
        if (i !== -1) return [...cur.slice(0, i), msg, ...cur.slice(i)];
      }
      return [...cur, msg];
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
    setCallIdleClosed(false);
    setIdleEndedOpen(false); // a new/reconnected call supersedes any lingering idle-timeout modal
    setCallMuted(false);
    setCallEchoProne(false);
    setCallHalfDuplex(false);
    setCallStartedAt(null);
    liveUserIdRef.current = null;
    liveAsstIdRef.current = null;
    liveUserTextRef.current = "";
    liveAsstTextRef.current = "";
    const profileBlock = memoryOn ? renderProfileBlock(profileFactsRef.current) ?? undefined : undefined;
    const recentContext = memoryOn ? (await buildRecentContext()) ?? undefined : undefined;
    const agendaBlock = memoryOn ? renderAgendaBlock(tasksRef.current) ?? undefined : undefined;
    const session = new LiveSession(apiKey, liveModel, voice, memoryOn, profileBlock, recentContext, lang, agendaBlock);
    session.setHeadphones(callHeadphones);
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
        // The user went quiet for the whole idle window on their turn — the session is hanging up for
        // them. Flag it so the closing bar explains the auto-end; the "closed" state itself is handled
        // by the effect below (logs the duration, then dismisses).
        onIdleTimeout: () => setCallIdleClosed(true),
      });
      // Which output path the session ended up on is only known once start() resolves; it drives
      // the CallBar's half-duplex affordances (tap-to-interrupt orb, headphones toggle).
      setCallEchoProne(session.echoProne);
      setCallHalfDuplex(session.halfDuplex);
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

  function toggleHeadphones() {
    const next = !callHeadphones;
    setCallHeadphones(next);
    try {
      localStorage.setItem("voice:headphones", next ? "1" : "0");
    } catch {
      /* storage may be unavailable (private mode) — the toggle still works for this call */
    }
    const s = liveRef.current;
    if (s) {
      s.setHeadphones(next);
      setCallHalfDuplex(s.halfDuplex);
    }
  }

  function interruptCall() {
    liveRef.current?.interrupt();
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
      if (callIdleClosed) {
        // Idle auto-hang-up: swap the bar out for the explanatory modal (which offers Reconnect),
        // so the reason the call ended — and the way back into it — is unmissable.
        setIdleEndedOpen(true);
        setCallState(null);
        return;
      }
      const t = setTimeout(() => setCallState(null), 1500);
      return () => clearTimeout(t);
    }
    // finishCall reads a ref and is safe to omit from deps; rerunning only on callState is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callState]);

  async function deleteAccount() {
    setDeletingAccount(true);
    setDeleteAccountError("");
    try {
      const res = await api("/api/auth/account", { method: "DELETE" });
      if (!res.ok) throw new Error();
      setConfirmDeleteAccount(false);
      onLogout(); // account + cookie gone server-side; reset the UI to the sign-in screen
    } catch {
      setDeleteAccountError(t.chat.deleteAccountError);
    } finally {
      setDeletingAccount(false);
    }
  }

  return (
    <div className="app-shell flex flex-row bg-linear-to-b from-black/2 to-transparent dark:from-white/5">
      <Sidebar
        user={user}
        textModel={textModel}
        onNewChat={() => {
          if (callState) void endCall(); // tear down any live call so its mic/transcript don't leak into the new chat
          setIdleEndedOpen(false); // a stale "reconnect" would resume into the chat we're clearing
          void runExtraction(2); // distil the conversation we're leaving before clearing it
          setMessages([]);
          setReplyTo(null); // a quote from the old chat has nothing to point at anymore
          conversationIdRef.current = uid();
          extractCursorRef.current = 0;
        }}
        onOpenSettings={() => setDrawerOpen(true)}
        onSignOut={() => setConfirmLogout(true)}
        onDeleteAccount={() => {
          setDeleteAccountError("");
          setConfirmDeleteAccount(true);
        }}
        open={navOpen}
        onClose={() => setNavOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-black/10 bg-white/80 px-4 py-3 backdrop-blur md:hidden dark:border-white/10 dark:bg-neutral-950/80">
          <button
            onClick={() => setNavOpen(true)}
            title={t.sidebar.menu}
            aria-label={t.sidebar.openMenu}
            className="-ml-2 rounded-md p-2 text-black/60 transition hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
          >
            <Menu size={18} />
          </button>
          <MessageCircle size={18} className="shrink-0" aria-hidden="true" />
          <span className="font-semibold">EverVault</span>
        </header>

        <main className="flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-4 py-20 text-center">
              <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-linear-to-br from-blue-500 to-violet-500 shadow-md">
                <Sparkles className="h-8 w-8 text-white" aria-hidden="true" />
              </div>
              <h1 className="inline-flex items-center gap-2 text-2xl font-semibold">
                {t.chat.greeting(user.name?.split(" ")[0] || t.chat.greetingFallbackName)}
                <Hand className="h-6 w-6 text-amber-500" aria-hidden="true" />
              </h1>
              <p className="mt-2 max-w-md text-sm text-black/55 dark:text-white/55">
                {t.chat.emptyBody}
              </p>
              {!apiKey && (
                <button
                  onClick={() => setDrawerOpen(true)}
                  className="mt-6 rounded-full bg-blue-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700"
                >
                  {t.chat.addKey}
                </button>
              )}
            </div>
          ) : (
            <MessageList
              messages={messages}
              userName={user.name}
              userPicture={user.picture}
              onPlayAudio={playAudio}
              playingAudioId={audioPlaying?.id ?? null}
              audioPaused={audioPlaying?.paused ?? false}
              onReply={setReplyTo}
              scrollSignal={!!callState}
            />
          )}
        </main>

        {callState && (
          <CallBar
            state={callState}
            muted={callMuted}
            error={callError}
            idleClosed={callIdleClosed}
            startedAt={callStartedAt}
            echoProne={callEchoProne}
            halfDuplex={callHalfDuplex}
            headphones={callHeadphones}
            onToggleMute={toggleMute}
            onToggleHeadphones={toggleHeadphones}
            onInterrupt={interruptCall}
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
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
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

      <ConfirmDialog
        open={confirmLogout}
        title={t.chat.signOutTitle}
        message={t.chat.signOutMessage}
        confirmLabel={t.chat.signOutConfirm}
        cancelLabel={t.common.cancel}
        confirmVariant="danger"
        onClose={() => setConfirmLogout(false)}
        onConfirm={() => {
          setConfirmLogout(false);
          onLogout();
        }}
      />

      <ConfirmDialog
        open={confirmDeleteAccount}
        title={t.chat.deleteAccountTitle}
        message={
          <>
            {t.chat.deleteAccountMessage}
            <span className="mt-2 block">{t.chat.deleteAccountPrompt(t.chat.deleteAccountKeyword)}</span>
            {deleteAccountError && (
              <span className="mt-2 block text-red-600 dark:text-red-400">{deleteAccountError}</span>
            )}
          </>
        }
        requireText={t.chat.deleteAccountKeyword}
        inputPlaceholder={t.chat.deleteAccountKeyword}
        confirmLabel={t.chat.deleteAccountConfirm}
        cancelLabel={t.common.cancel}
        confirmVariant="danger"
        busy={deletingAccount}
        onClose={() => {
          if (!deletingAccount) setConfirmDeleteAccount(false);
        }}
        onConfirm={deleteAccount}
      />

      <CallEndedModal
        open={idleEndedOpen}
        onReconnect={() => {
          setIdleEndedOpen(false);
          void startCall(); // resume the conversation on a fresh Live socket
        }}
        onClose={() => setIdleEndedOpen(false)}
      />
    </div>
  );
}
