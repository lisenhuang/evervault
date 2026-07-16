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
import { playPcm16Handle, releaseAudioPlayback, startRecording, unlockAudioPlayback, type Recorder } from "./lib/audio";
import { embedDocument } from "./lib/embed";
import { type Content, describeDocument, describeImage, streamTextWithTools, synthesizeSpeech, type Tool, transcribeAudio, type ToolExecutor } from "./lib/gemini";
import { contentsAreTextOnly, streamServerChatWithTools, toNeutralMessages } from "./lib/serverChat";
import { fetchVoiceReply, startVoiceReply, type VoiceReplyAudio } from "./lib/voiceReply";
import type { PreparedFile } from "./lib/files";
import { LiveSession, type LiveState } from "./lib/liveSession";
import { setAudioSessionType } from "./lib/liveAudio";
import { buildRecentContext, retrieveContext } from "./lib/recall";
import { CAPABILITY_BOUNDS, CONFIDENTIALITY } from "./lib/persona";
import { MEMORY_PERSONA, RECALL_MEMORY_DECLARATION, runRecallTool } from "./lib/recallTool";
import { isTaskTool, runTaskTool, TASK_TOOL_DECLARATIONS, TASKS_PERSONA } from "./lib/taskTools";
import { isSuggestionTool, RECORD_SUGGESTION_DECLARATION, runSuggestionTool, SUGGESTION_PERSONA, type SuggestionImage } from "./lib/suggestionTool";
import { extractAndSyncProfile, type Fact, getProfile, renderProfileBlock } from "./lib/profile";
import { getTasks, renderAgendaBlock, type Task } from "./lib/tasks";
import { store } from "./lib/store";
import { styleDirective, type ResponseStyle, type StyleSurface } from "./lib/responseStyle";
import { getSettings, putSettings } from "./lib/settings";
import { currentTimeContext } from "./lib/time";
import { recordTurn, type TurnItem } from "./recordApi";
import { useVisualViewport } from "./useVisualViewport";
import { api, type Me } from "./authApi";
import { friendlyAiError, micErrorMessage } from "./lib/aiError";
import { reportAiError } from "./lib/errorReport";
import { runWithSuspensionRetry } from "./lib/suspensionRetry";
import type { ChatMessage, ReplyRef } from "./types";
import { useLang } from "@/i18n/LanguageProvider";
import { aiReplyDirective } from "@/i18n/config";

const uid = () => crypto.randomUUID();

/** Small await-able delay, used by the voice-reply poll loop. */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Recordings shorter than this are discarded instead of sent: a blink-quick tap-tap holds no speech,
// and transcribing/answering near-empty audio produces nonsense that derails the conversation.
const MIN_VOICE_MESSAGE_SECONDS = 0.5;

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
async function fileMemoryLine(model: string, f: PreparedFile): Promise<string> {
  const header = `[The user sent ${FILE_KIND_LABEL[f.kind]} named "${f.name}"]`;
  if (f.kind === "image" && f.base64) {
    const desc = await describeImage(model, f.base64, f.mimeType).catch(() => "");
    return desc ? `${header} It shows: ${clipMemory(desc)}` : header;
  }
  if (f.kind === "audio" && f.base64) {
    const tx = await transcribeAudio(model, f.base64, f.mimeType).catch(() => "");
    return tx ? `${header} Transcript of the audio: ${clipMemory(tx)}` : header;
  }
  if (f.kind === "pdf" && f.base64) {
    const desc = await describeDocument(model, f.base64, f.mimeType).catch(() => "");
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

// The screenshot(s) the user shared for a suggestion. The model never handles image bytes — it just
// calls record_suggestion with includeImage — so we attach the images from the SINGLE most-recent
// image-bearing user message, and only if it's within a short lookback. Taking just that one turn (not a
// sweep of the whole window) keeps an unrelated image the user shared earlier from riding along; the
// model's includeImage flag is the primary gate, this scoping is the backstop.
const SUGGESTION_IMAGE_LOOKBACK = 8;
const SUGGESTION_IMAGE_MAX = 6;
function sharedSuggestionImages(msgs: ChatMessage[]): SuggestionImage[] {
  const start = Math.max(0, msgs.length - SUGGESTION_IMAGE_LOOKBACK);
  for (let i = msgs.length - 1; i >= start; i--) {
    const m = msgs[i];
    if (m.role !== "user" || !m.files) continue;
    const imgs = m.files.filter((f) => f.kind === "image" && f.base64);
    if (imgs.length === 0) continue;
    // Most recent image-bearing turn — attach its images and stop (don't reach further back).
    return imgs.slice(0, SUGGESTION_IMAGE_MAX).map((f) => ({ base64: f.base64!, mime: f.mimeType }));
  }
  return [];
}

export default function Chat({ user, onLogout }: { user: Me; onLogout: () => void }) {
  // Keep the shell sized to the visible viewport so the composer rides above the keyboard.
  useVisualViewport();
  const { t, lang } = useLang();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // Models are admin-configured for the /webapp and fetched from the server on mount; the store getters
  // seed sensible defaults until that resolves. Voice is a user preference (persisted locally).
  const [textModel, setTextModel] = useState(store.getTextModel());
  const [audioModel, setAudioModel] = useState(store.getAudioModel());
  const [liveModel, setLiveModel] = useState(store.getLiveModel());
  // The admin's primary text model isn't Gemini (e.g. ChatGPT): text turns go through the backend's
  // /api/chat/ai/text instead of the direct Gemini proxy. Session-only (re-read on every mount) and
  // defaults to false, so an old backend or a failed config fetch keeps the plain Gemini path.
  const [serverChat, setServerChat] = useState(false);
  const [voice, setVoice] = useState(store.getVoice());
  // Response-style presets, chosen separately per surface (text / spoken voice reply / live call).
  // Default ("default") injects no directive, so an untouched preference keeps the built-in tone.
  const [textStyle, setTextStyle] = useState<ResponseStyle>(store.getTextStyle());
  const [voiceStyle, setVoiceStyle] = useState<ResponseStyle>(store.getVoiceStyle());
  const [liveStyle, setLiveStyle] = useState<ResponseStyle>(store.getLiveStyle());
  // Surfaces the user has changed this session. The mount-time settings fetch (loadSettings) is async, so
  // it must never overwrite a fresh in-session pick with the value it read before the click landed.
  const styleTouched = useRef<Set<StyleSurface>>(new Set());
  // False once Chat has unmounted (e.g. logout). loadSettings checks it after its async read so an
  // in-flight fetch can't re-seed the localStorage cache for an account that has since signed out.
  const settingsActiveRef = useRef(true);
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
  // Message awaiting delete confirmation — set from the context menu's Delete, cleared on confirm/cancel.
  const [pendingDelete, setPendingDelete] = useState<ChatMessage | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  // Only one spoken reply plays at a time — starting another (auto-play or a manual "Play reply"
  // click) stops whatever is currently playing first.
  const playingAudioRef = useRef<{ stop: () => void; pause: () => void; resume: () => void } | null>(null);
  // Which reply's audio is loaded in the player and whether it's paused — drives the bubble's play
  // button (animated while playing, "resume" while paused). null when nothing is loaded.
  const [audioPlaying, setAudioPlaying] = useState<{ id: string; paused: boolean } | null>(null);
  const playAudioClip = useCallback((id: string, base64: string, sampleRate: number) => {
    playingAudioRef.current?.stop();
    // iOS: route this clip to the "playback" audio session so it plays through the hardware Silent
    // switch (like a music/podcast app). No-op off iOS. Released back to "auto" when the clip ends
    // — and only by the handle that's still current, so replacing one clip with another (which
    // re-pins "playback" just below) doesn't get reset out from under the new clip.
    setAudioSessionType("playback");
    const handle = playPcm16Handle(base64, sampleRate);
    playingAudioRef.current = handle;
    setAudioPlaying({ id, paused: false });
    void handle.ended.then(() => {
      if (playingAudioRef.current === handle) {
        playingAudioRef.current = null;
        setAudioPlaying(null);
        setAudioSessionType("auto");
      }
    });
  }, []);

  // Stop any spoken reply that's currently playing or paused and clear the player state. Starting a
  // recording or a call calls this first: the assistant's voice should go quiet as the user starts
  // talking, and it frees the reply element so unlockAudioPlayback() can re-prime it (priming skips
  // itself while a clip still owns the element — see audio.ts).
  const stopReplyAudio = useCallback(() => {
    playingAudioRef.current?.stop();
    playingAudioRef.current = null;
    setAudioPlaying(null);
    setAudioSessionType("auto");
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
    if (!store.getMemoryOn()) return;
    profileFactsRef.current = await getProfile();
  }, []);

  const refreshTasks = useCallback(async () => {
    if (!store.getMemoryOn()) return;
    tasksRef.current = await getTasks("open");
  }, []);

  // Distil new turns into the profile (fire-and-forget; never blocks chat). `minNew` guards against
  // extracting tiny fragments — a closing conversation needs one exchange, an idle tick needs more.
  const runExtraction = useCallback(async (minNew = 2) => {
    if (!store.getMemoryOn()) return;
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

  // Load the admin-configured models + default voice for the /webapp (the app is keyless, so users no
  // longer pick models). Cache them in the store so the next load has them immediately, and adopt the
  // default voice only when the user hasn't chosen one yet.
  const loadConfig = useCallback(async () => {
    try {
      const res = await api("/api/chat/ai/config");
      if (!res.ok) return;
      const cfg = (await res.json()) as {
        textModel: string; audioModel: string; liveModel: string; defaultVoice: string; serverChat?: boolean;
      };
      if (cfg.textModel) { store.setTextModel(cfg.textModel); setTextModel(cfg.textModel); }
      if (cfg.audioModel) { store.setAudioModel(cfg.audioModel); setAudioModel(cfg.audioModel); }
      if (cfg.liveModel) { store.setLiveModel(cfg.liveModel); setLiveModel(cfg.liveModel); }
      if (cfg.defaultVoice && !store.getVoiceChosen()) { store.setVoice(cfg.defaultVoice); setVoice(cfg.defaultVoice); }
      setServerChat(!!cfg.serverChat);
    } catch {
      /* keep the defaults */
    }
  }, []);

  // Reconcile the per-surface response styles with the server (cross-device source of truth). State is
  // seeded synchronously from localStorage for an instant paint; this adopts the stored server value once
  // it arrives. Precedence, per surface: (1) if the user already changed it this session, leave it alone;
  // (2) if there's an unsynced local pick (pending), keep local and re-push it; (3) otherwise the server
  // wins when it holds a non-default value; (4) on a browser that had a pre-feature local choice, migrate
  // that up once. A failed read (offline / older backend mid-rollout) is a no-op: keep local, don't migrate.
  const loadSettings = useCallback(async () => {
    const s = await getSettings();
    // Bail on a failed read (never mistake failure for "server is all-default"), or if Chat unmounted
    // while the fetch was in flight (logout) — applying now would re-seed a signed-out account's cache.
    if (!s || !settingsActiveRef.current) return;
    const surfaces: { surface: StyleSurface; server: ResponseStyle; local: ResponseStyle; apply: (v: ResponseStyle) => void }[] = [
      { surface: "text", server: s.text, local: store.getTextStyle(), apply: (v) => { store.setTextStyle(v); setTextStyle(v); } },
      { surface: "voice", server: s.voice, local: store.getVoiceStyle(), apply: (v) => { store.setVoiceStyle(v); setVoiceStyle(v); } },
      { surface: "live", server: s.live, local: store.getLiveStyle(), apply: (v) => { store.setLiveStyle(v); setLiveStyle(v); } },
    ];
    const migrated = store.getStyleMigrated();
    const pushUp: Partial<Record<StyleSurface, ResponseStyle>> = {};
    for (const { surface, server, local, apply } of surfaces) {
      if (styleTouched.current.has(surface)) continue; // changed this session — the pick + its PUT win
      if (store.getStylePending(surface)) {
        // An earlier pick whose PUT never confirmed: keep the local value and re-push it (incl. "default",
        // which resets the surface). If it already matches the server, clear the stale flag.
        if (local !== server) pushUp[surface] = local;
        else store.setStylePending(surface, false);
        continue;
      }
      // One-time legacy migration: a browser that had a pre-feature local choice we've never synced up.
      // Mark it pending so a failed push retries next load instead of being lost to the migrated flag.
      if (!migrated && server === "default" && local !== "default") {
        store.setStylePending(surface, true);
        pushUp[surface] = local;
        continue;
      }
      // Otherwise the server is authoritative: adopt it, including "default" — which resets a stale local
      // cache when the pref was turned off on another device.
      if (server !== local) apply(server);
    }
    if (Object.keys(pushUp).length) putSettings(pushUp);
    store.setStyleMigrated(); // only reached after a successful read — the legacy migration is now done
  }, []);

  useEffect(() => {
    settingsActiveRef.current = true;
    void loadConfig();
    void loadSettings();
    store.setMemoryOn(true); // memory is always on; keep the persisted guard in sync
    void refreshProfile();
    void refreshTasks();
    return () => { settingsActiveRef.current = false; };
  }, [loadConfig, loadSettings, refreshProfile, refreshTasks]);

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

  function pickVoice(v: string) {
    store.setVoice(v);
    setVoice(v);
  }

  // Persist + apply a response-style choice. Each surface is independent (the model reads its own style
  // on the next turn / next call). We write the localStorage cache for an instant, offline-safe value,
  // mark the surface touched (so an in-flight mount fetch can't clobber it) and pending (so an unsynced
  // pick survives a reload), then push it to the server fire-and-forget for cross-device persistence.
  function pickStyle(surface: StyleSurface, v: ResponseStyle, cache: (v: ResponseStyle) => void, apply: (v: ResponseStyle) => void) {
    styleTouched.current.add(surface);
    store.setStylePending(surface, true);
    cache(v);
    apply(v);
    putSettings({ [surface]: v });
  }
  const pickTextStyle = (v: ResponseStyle) => pickStyle("text", v, store.setTextStyle, setTextStyle);
  const pickVoiceStyle = (v: ResponseStyle) => pickStyle("voice", v, store.setVoiceStyle, setVoiceStyle);
  const pickLiveStyle = (v: ResponseStyle) => pickStyle("live", v, store.setLiveStyle, setLiveStyle);

  // --- Voice-message reply audio (synthesized server-side, resilient to a backgrounded tab) ---

  // Replies whose audio a poll loop is already resolving, so the initial kickoff and the
  // foreground-resume handler never spin up duplicate loops for the same reply.
  const voiceResolveRef = useRef<Set<string>>(new Set());

  // Attach a finished spoken clip to its reply and reveal the text. Guarded so a late arrival can't
  // clobber a reply that was already resolved (or deleted). Auto-plays only when the tab is foreground —
  // a clip that resolves while the user is away shouldn't play to no one (and iOS blocks un-gestured
  // playback anyway); the reply's "Play" button covers that case.
  const applyVoiceAudio = useCallback(
    (asstId: string, audio: VoiceReplyAudio) => {
      // Decide whether this clip should auto-play from the ref, NOT from a flag set inside the
      // setMessages updater: React may defer running the updater (it batches state updates from
      // async contexts like this poll callback), and a deferred updater would leave the flag false
      // here — silently skipping the auto-play and releasing the priming loop for nothing. The ref
      // always reflects the latest committed messages, so the decision is deterministic.
      const target = messagesRef.current.find((m) => m.id === asstId);
      const shouldApply = !!target && !!target.pendingAudio && !target.audio;
      setMessages((cur) =>
        cur.map((m) =>
          m.id === asstId && m.pendingAudio && !m.audio
            ? { ...m, streaming: false, pendingAudio: false, audio }
            : m,
        ),
      );
      if (shouldApply && typeof document !== "undefined" && document.visibilityState === "visible") {
        playAudioClip(asstId, audio.base64, audio.sampleRate);
      } else {
        // The clip won't auto-play (hidden tab, or it was already resolved/deleted) — stop the silent
        // priming loop; the bubble's "Play" button takes over from here.
        releaseAudioPlayback();
      }
    },
    [playAudioClip],
  );

  // Give up on a reply's spoken audio: reveal its text without a clip (the same end state a TTS failure
  // has always produced). No-op once the reply is no longer waiting on audio.
  const revealWithoutAudio = useCallback((asstId: string) => {
    releaseAudioPlayback(); // no clip will claim the element — stop the silent priming loop
    setMessages((cur) =>
      cur.map((m) => (m.id === asstId && m.pendingAudio ? { ...m, streaming: false, pendingAudio: false } : m)),
    );
  }, []);

  // Compatibility fallback for a backend without the server-side endpoint (or a failed kickoff): synthesize
  // in the browser, exactly as before. This path is still killed by backgrounding — it's a shim, not the
  // fix — but it keeps a foreground voice reply working against any backend during a rollout.
  const clientSideSynthesize = useCallback(
    async (asstId: string, text: string, voice: string) => {
      try {
        applyVoiceAudio(asstId, await synthesizeSpeech(audioModel, text, voice));
      } catch {
        revealWithoutAudio(asstId);
      }
    },
    [audioModel, applyVoiceAudio, revealWithoutAudio],
  );

  // Drive a reply's spoken audio to completion: ask the backend to synthesize it (server-side, so it
  // finishes even while the tab is backgrounded), then poll until the clip is ready. Only FOREGROUND time
  // counts against the attempt budget — a suspended tab freezes this loop, and the time the user was away
  // must not be spent as wasted attempts. Guarded so the initial call and the resume handler share one loop.
  const ensureVoiceReplyAudio = useCallback(
    async (asstId: string, text: string) => {
      if (!text.trim()) {
        revealWithoutAudio(asstId);
        return;
      }
      if (voiceResolveRef.current.has(asstId)) return;
      voiceResolveRef.current.add(asstId);
      try {
        const voice = store.getVoice();
        if (!(await startVoiceReply(asstId, text, voice))) {
          // Endpoint missing / request failed → in-browser fallback so the reply still gets a voice.
          await clientSideSynthesize(asstId, text, voice);
          return;
        }
        let visibleAttempts = 0;
        const maxVisibleAttempts = 75; // ~75s of FOREGROUND polling; a synthesis normally lands in a few
        for (;;) {
          const msg = messagesRef.current.find((m) => m.id === asstId);
          if (!msg || !msg.pendingAudio || msg.audio) {
            // Resolved, deleted, or chat cleared. Release the priming loop for the deleted/cleared
            // cases — a no-op when the resolved clip claimed the element (its own lifecycle rules it).
            releaseAudioPlayback();
            return;
          }
          if (typeof document !== "undefined" && document.hidden) {
            await sleep(1000); // tab suspended — wait without spending the budget
            continue;
          }
          const res = await fetchVoiceReply(asstId);
          if (res.status === "ready") {
            applyVoiceAudio(asstId, { base64: res.base64, sampleRate: res.sampleRate });
            return;
          }
          if (res.status === "failed") {
            revealWithoutAudio(asstId);
            return;
          }
          if (res.status === "unknown") await startVoiceReply(asstId, text, voice); // lost/swept — re-kick
          if (++visibleAttempts >= maxVisibleAttempts) {
            revealWithoutAudio(asstId);
            return;
          }
          await sleep(1000);
        }
      } catch {
        revealWithoutAudio(asstId);
      } finally {
        voiceResolveRef.current.delete(asstId);
      }
    },
    [applyVoiceAudio, revealWithoutAudio, clientSideSynthesize],
  );

  // When the tab returns to the foreground, re-drive any spoken reply still waiting on its audio. This is
  // the recovery path for the bug being fixed: the user fired a voice message, backgrounded the tab (which
  // froze the in-page poll loop), and returned — the audio was synthesized server-side in the meantime, so
  // fetch it now. `ensureVoiceReplyAudio` is guarded against duplicate loops, so firing alongside a
  // still-running poll is harmless. Only "text done, audio pending" replies match (streaming already false).
  useEffect(() => {
    const resume = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      for (const m of messagesRef.current) {
        if (m.role === "assistant" && m.pendingAudio && !m.audio && !m.streaming && !m.error) {
          void ensureVoiceReplyAudio(m.id, m.text);
        }
      }
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("pageshow", resume);
    return () => {
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pageshow", resume);
    };
  }, [ensureVoiceReplyAudio]);

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
    // Response style is set separately for typed replies and spoken (voice-message) replies, so a
    // reply that will be read aloud uses the voice style; everything else uses the text style. Empty
    // for "default", in which case filter(Boolean) drops it and the built-in tone stands.
    const styleDir = styleDirective(speak ? voiceStyle : textStyle);
    // The feedback tool is available whether or not memory is on: forwarding a suggestion to the
    // developers doesn't depend on memory. It attaches whatever screenshots the user just shared.
    const runSuggestion = (args: Record<string, unknown>) =>
      runSuggestionTool(args, () => sharedSuggestionImages(messagesRef.current));
    // When the admin's primary text model isn't Gemini, run the turn server-side — but only for
    // all-text conversations: inline media (images / PDFs / voice clips, replayed in history) needs
    // Gemini's multimodal input, so those turns stay on the direct proxy path.
    const stream = (sys: string, tools: Tool[], runTool: ToolExecutor) =>
      serverChat && contentsAreTextOnly(contents)
        ? streamServerChatWithTools(toNeutralMessages(contents), sys, tools, runTool)
        : streamTextWithTools(textModel, contents, sys, tools, runTool);
    if (memoryOn) {
      // Ground the reply in the durable profile (who the user is) + today's task agenda + persona +
      // current time. The agenda is re-rendered every turn, so task tool calls show up mid-conversation.
      const sys = [
        renderProfileBlock(profileFactsRef.current),
        renderAgendaBlock(tasksRef.current),
        langDirective,
        styleDir,
        CONFIDENTIALITY,
        CAPABILITY_BOUNDS,
        MEMORY_PERSONA,
        TASKS_PERSONA,
        SUGGESTION_PERSONA,
        currentTimeContext(),
      ]
        .filter(Boolean)
        .join("\n\n");
      const tools = [
        { functionDeclarations: [RECALL_MEMORY_DECLARATION, ...TASK_TOOL_DECLARATIONS, RECORD_SUGGESTION_DECLARATION] },
      ];
      const runTool = (name: string, args: Record<string, unknown>) =>
        isSuggestionTool(name)
          ? runSuggestion(args)
          : isTaskTool(name)
            ? runTaskTool(name, args, () => void refreshTasks())
            : runRecallTool(args);
      for await (const delta of stream(sys, tools, runTool)) {
        onDelta(delta);
      }
    } else {
      const sys = [langDirective, styleDir, CONFIDENTIALITY, CAPABILITY_BOUNDS, SUGGESTION_PERSONA, currentTimeContext()]
        .filter(Boolean)
        .join("\n\n");
      const tools = [{ functionDeclarations: [RECORD_SUGGESTION_DECLARATION] }];
      const runTool = (name: string, args: Record<string, unknown>) => runSuggestion(args);
      for await (const delta of stream(sys, tools, runTool)) {
        onDelta(delta);
      }
    }
    const finalText = acc || "_(no response)_";
    if (speak && acc) {
      // Voice reply: the text has fully streamed in, but keep it behind the "typing" dots (pendingAudio)
      // until the spoken audio is ready, so the reply lands as text + voice together instead of the text
      // racing ahead of the slower TTS. Synthesis runs SERVER-SIDE now (see ensureVoiceReplyAudio): the
      // backend generates the voice on a worker that keeps going even if the tab is backgrounded — the
      // exact case where the old in-page TTS was killed and the reply came back voiceless. Detached, so
      // the caller settles immediately; `pendingAudio` alone keeps the composer disabled until it lands.
      setMessages((cur) => cur.map((m) => (m.id === asstId ? { ...m, streaming: false, text: finalText } : m)));
      void ensureVoiceReplyAudio(asstId, acc);
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
      // Retry across an iOS tab suspension (see stopVoice): leaving the tab mid-reply kills the in-flight
      // request, which rejects with "Load failed" on return. Re-run rather than error out. Each attempt
      // rebuilds `contents` fresh — the tool loop appends to it — and re-runs RAG retrieval.
      const reply = await runWithSuspensionRetry(async (attempt) => {
        if (attempt > 0) {
          setMessages((cur) => cur.map((m) => (m.id === asstId ? { ...m, text: "", streaming: true } : m)));
        }
        const preface = await ragPreface(text);
        const contents = preface ? [preface, ...toContents(base)] : toContents(base);
        return runAssistant(asstId, contents, false);
      });
      if (files?.length) {
        // Record the turn so past attachments can be recalled: each file becomes a memory line that
        // states the user *sent* a file (type + name) plus whatever content we can extract — image
        // description, audio transcript, PDF summary, or the file's text (a second generateContent
        // call per binary file). The first image itself also goes to R2. This way the AI always
        // remembers a file was sent and what it contained, even if it can't produce the file back.
        // Best-effort — never blocks the chat.
        void (async () => {
          const lines = await Promise.all(files.map((f) => fileMemoryLine(textModel, f)));
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
      const fe = friendlyAiError(e, t);
      reportAiError(fe, "chat.send");
      setMessages((cur) =>
        cur.map((m) => (m.id === asstId ? { ...m, streaming: false, error: true, text: fe.text } : m)),
      );
    } finally {
      setStreaming(false);
    }
  }

  async function startVoice() {
    // Silence any spoken reply first — the assistant shouldn't keep talking into the recording, and
    // freeing the reply element lets the unlock below re-prime it. Synchronous, so the gesture holds.
    stopReplyAudio();
    // The mic press is a user gesture, and it's the earliest one in the voice-message flow — unlock
    // spoken-reply playback now (synchronously, before the awaited getUserMedia) so the reply that
    // lands seconds later can auto-play on iOS instead of waiting for a "Play" tap. Best-effort and
    // isolated in its own try/catch so an unlock hiccup can never bubble up as a mic error, and so the
    // very next statement — startRecording — is still the first `await` of the gesture (iOS drops the
    // mic request if another async step runs before it).
    try {
      unlockAudioPlayback();
    } catch {
      /* playback priming is best-effort; the reply's "Play" button plays it directly on tap */
    }
    try {
      recorderRef.current = await startRecording();
      setVoiceState("recording");
    } catch (e) {
      setVoiceState("idle");
      releaseAudioPlayback(); // recording never started — no reply is coming; stop the priming loop
      // startRecording throws a typed MicError; micErrorMessage turns each reason into specific,
      // actionable copy (unsupported browser, insecure context, blocked, no device, in use).
      const text = micErrorMessage(e, t) ?? t.chat.micGeneric;
      setMessages((cur) => [...cur, { id: uid(), role: "assistant", text, error: true }]);
    }
  }

  async function stopVoice() {
    const rec = recorderRef.current;
    if (!rec) return;
    recorderRef.current = null;
    // A stray clip (e.g. a slow previous reply that landed mid-recording) must not keep talking over
    // the send. This also frees the reply element, and the stop tap is a gesture — re-prime playback
    // so the reply that's about to be synthesized can auto-play (see unlockAudioPlayback).
    stopReplyAudio();
    unlockAudioPlayback();
    setVoiceState("processing");
    setStreaming(true);
    const userMsg: ChatMessage = { id: uid(), role: "user", text: "", kind: "voice" };
    const asstId = uid();
    try {
      const { base64, mimeType, seconds } = await rec.stop();
      // rec.stop() released the mic and reset the session to "auto". Pin it to "playback" NOW and
      // hold it there through the reply: the priming loop (re-kicked just below) and the reply clip
      // that replaces it then play under ONE stable session. With no session reconfiguration at reply
      // time, the silently-looping element stays cleanly "playing", so the deferred auto-play is
      // treated as a continuation and isn't re-locked. Still within the stop tap's activation window.
      setAudioSessionType("playback");
      unlockAudioPlayback();
      // A blink-quick tap-tap captures no usable speech. Sent anyway, the transcription model answers
      // the silence with its own prompt ("Please provide the audio file…"), which lands in the user's
      // bubble and derails the conversation — drop the recording with a hint instead.
      if (seconds < MIN_VOICE_MESSAGE_SECONDS) {
        releaseAudioPlayback(); // nothing will be sent — no reply is coming; stop the priming loop
        setMessages((cur) => [
          ...cur,
          { id: uid(), role: "assistant", text: t.chat.recordingTooShort, error: true },
        ]);
        return; // finally() below resets the composer state
      }
      const base = [...messages, userMsg];
      // pendingAudio holds the reply's text behind the typing dots until its spoken audio is ready
      // (see runAssistant), so the text doesn't appear ahead of the slower voice.
      setMessages([...base, { id: asstId, role: "assistant", text: "", streaming: true, kind: "voice", pendingAudio: true }]);
      // Transcribe in parallel with the reply (a second, audio-capable generateContent call). Fills the
      // user's bubble in place when it lands; an empty/failed transcript degrades to the "Voice message"
      // label so the turn still reads sensibly and stays in toContents() history.
      const transcriptPromise = transcribeAudio(textModel, base64, mimeType)
        .then((t) => {
          setMessages((cur) => cur.map((m) => (m.id === userMsg.id ? { ...m, text: t || "Voice message" } : m)));
          return t;
        })
        .catch(() => "");
      const voiceInstruction =
        "Respond conversationally to this spoken message. Act on what they say the same as if " +
        "they had typed it — including using your tools when appropriate (e.g. if they agree to " +
        "share feedback with the team, call record_suggestion).";
      // A ChatGPT primary can't hear audio, so the server-chat path answers from the transcript:
      // wait for it (transcription stays a Gemini call), then send it as text. An empty transcript
      // (no speech recognized / transcription down) degrades to the raw-audio Gemini path so the
      // user still gets an answer. Gemini-primary keeps hearing the audio itself, tone and all.
      const serverTranscript = serverChat ? await transcriptPromise : "";
      const lastTurn: Content =
        serverChat && serverTranscript
          ? { role: "user", parts: [{ text: `[Voice message — transcript] ${serverTranscript}` }, { text: voiceInstruction }] }
          : { role: "user", parts: [{ inlineData: { mimeType, data: base64 } }, { text: voiceInstruction }] };
      // Speak the reply too. TTS runs in the background (see runAssistant), so it doesn't hold the
      // composer's busy state — the voice button stays usable while the audio is being generated.
      // Retry across an iOS tab suspension: backgrounding the app mid-reply kills the in-flight request
      // (it rejects with "Load failed" on return), so re-run the generation once the user is back instead
      // of surfacing a bogus "server unreachable". The recorded audio is already captured, so each attempt
      // just rebuilds `contents` fresh — the tool loop appends to that array, so it can't be reused as-is.
      const reply = await runWithSuspensionRetry((attempt) => {
        if (attempt > 0) {
          setMessages((cur) => cur.map((m) => (m.id === asstId ? { ...m, text: "", streaming: true } : m)));
        }
        return runAssistant(asstId, [...toContents(messages), lastTurn], true);
      });
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
      releaseAudioPlayback(); // the turn failed — no reply audio is coming; stop the priming loop
      const fe = friendlyAiError(e, t);
      reportAiError(fe, "chat.voice");
      setMessages((cur) => {
        const errored: ChatMessage = { id: asstId, role: "assistant", text: fe.text, streaming: false, error: true };
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

  // Remove a message from the transcript (from the long-press / right-click menu). History is
  // in-memory only, so dropping it here is all it takes for it to disappear from the chatbox.
  function deleteMessage(m: ChatMessage) {
    // If this message's spoken clip is the one loaded in the player, stop it — its bubble is leaving.
    if (audioPlaying?.id === m.id) stopReplyAudio();
    setMessages((cur) => cur.filter((x) => x.id !== m.id));
    // Drop a pending reply that quoted the now-deleted message.
    setReplyTo((r) => (r?.id === m.id ? null : r));
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
    stopReplyAudio(); // silence any spoken reply before the call takes over the audio path
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
    const session = new LiveSession(
      liveModel,
      voice,
      memoryOn,
      profileBlock,
      recentContext,
      lang,
      agendaBlock,
      styleDirective(liveStyle),
    );
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
      // A mic-acquisition failure (denied / unsupported browser / no device) gets its own specific
      // message rather than the generic "something went wrong" — and isn't reported as an AI error.
      const micMsg = micErrorMessage(e, t);
      if (micMsg) {
        setCallError(micMsg);
        setCallState("error");
        return;
      }
      const fe = friendlyAiError(e, t);
      reportAiError(fe, "call.start");
      // The CallBar status line is single-line, so collapse the bubble format's blank line.
      setCallError(fe.text.replace(/\n+/g, " "));
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

  // Block the composer (text + voice) until the assistant has FULLY responded. For a voice reply the
  // spoken audio finishes AFTER the text (the bubble stays on `pendingAudio` while TTS runs), so this
  // keeps the mic disabled until the whole reply — text and audio — is ready, preventing a second voice
  // message from being sent mid-response.
  const composerBusy = streaming || messages.some((m) => m.pendingAudio);

  return (
    <div className="app-shell flex flex-row bg-linear-to-b from-black/2 to-transparent dark:from-white/5">
      <Sidebar
        user={user}
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
              onDelete={setPendingDelete}
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
          disabled={composerBusy}
          inCall={!!callState}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
        />
      </div>

      <KeyDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        voice={voice}
        onChangeVoice={pickVoice}
        textStyle={textStyle}
        voiceStyle={voiceStyle}
        liveStyle={liveStyle}
        onChangeTextStyle={pickTextStyle}
        onChangeVoiceStyle={pickVoiceStyle}
        onChangeLiveStyle={pickLiveStyle}
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

      <ConfirmDialog
        open={!!pendingDelete}
        title={t.message.deleteTitle}
        message={t.message.deleteConfirmMessage}
        confirmLabel={t.message.delete}
        cancelLabel={t.common.cancel}
        confirmVariant="danger"
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) deleteMessage(pendingDelete);
          setPendingDelete(null);
        }}
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
