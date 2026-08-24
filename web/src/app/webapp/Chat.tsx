"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Hand, Menu, MessageCircle, Sparkles } from "lucide-react";
import Sidebar from "./Sidebar";
import CallBar from "./CallBar";
import CallEndedModal from "./CallEndedModal";
import Composer, { type VoiceState } from "./Composer";
import KeyDrawer from "./KeyDrawer";
import MessageList from "./MessageList";
import TextSizeControl from "./TextSizeControl";
import ConfirmDialog from "@/components/ConfirmDialog";
import { playPcm16Handle, startRecording, unlockAudioPlayback, type Recorder } from "./lib/audio";
import { BRAND_NAME_HEARING, fixSpokenBrandName } from "./lib/brandName";
import { embedDocument } from "./lib/embed";
import { type Content, describeDocument, describeImage, streamTextWithTools, synthesizeSpeech, type Tool, transcribeAudio, type ToolExecutor } from "./lib/gemini";
import { contentsAreTextOnly, streamServerChatWithTools, toNeutralMessages } from "./lib/serverChat";
import { fetchVoiceReply, startVoiceReply, type VoiceReplyAudio } from "./lib/voiceReply";
import { MAX_VOICE_INLINE, type PreparedFile } from "./lib/files";
import { LiveSession, type LiveState } from "./lib/liveSession";
import { LiveVoiceMessage, renderConversation } from "./lib/liveVoiceMessage";
import { toLiveAttachments } from "./lib/liveAttachments";
import { setAudioSessionType } from "./lib/liveAudio";
import { buildRecentContext, retrieveContext } from "./lib/recall";
import { ANSWER_FIRST, CAPABILITY_BOUNDS, CONFIDENTIALITY, NO_REPETITION, SAFETY_BOUNDS } from "./lib/persona";
import { MEMORY_PERSONA, RECALL_MEMORY_DECLARATION, runRecallTool } from "./lib/recallTool";
import { isTaskTool, runTaskTool, TASK_TOOL_DECLARATIONS, TASKS_PERSONA, type TaskChange } from "./lib/taskTools";
import { buildTaskReceipt } from "./lib/taskReceipt";
import { asksToTrackSomething, buildRecheckNudge } from "./lib/taskIntent";
import {
  applyForget,
  FORGET_PERSONA,
  FORGET_TOOL_DECLARATIONS,
  isForgetTool,
  runForgetTool,
  type ForgetItem,
} from "./lib/forgetTool";
import { getStates, renderStateBlock, type UserState } from "./lib/state";
import { getEvents, renderEventsBlock, type LifeEvent } from "./lib/events";
import { maybeRollupDigests } from "./lib/digest";
import { FILE_TOOL_DECLARATIONS, FILES_PERSONA, isFileTool, runFileTool } from "./lib/fileTools";
import { fetchChatFileContent, type StoredFileMeta, uploadChatFile } from "./lib/filesApi";
import { isSuggestionTool, RECORD_SUGGESTION_DECLARATION, runSuggestionTool, SUGGESTION_PERSONA, type SuggestionImage } from "./lib/suggestionTool";
import {
  isWebSearchTool,
  runWebSearchTool,
  SEARCH_PERSONA_AVAILABLE,
  SEARCH_PERSONA_UNAVAILABLE,
  SEARCH_WEB_DECLARATION,
} from "./lib/webSearchTool";
import {
  FETCH_URL_DECLARATION,
  isUrlFetchTool,
  runUrlFetchTool,
  URL_FETCH_PERSONA,
} from "./lib/urlFetchTool";
import {
  isLinkTool,
  LINK_PERSONA,
  linkMarkdown,
  type OutgoingLink,
  runSendLinkTool,
  SEND_LINK_DECLARATION,
} from "./lib/linkTool";
import { extractAndSyncProfile, type Fact, getProfile, renderProfileBlock } from "./lib/profile";
import { catchUpRecurring, getTasks, localDateStr, renderAgendaBlock, type Task } from "./lib/tasks";
import { store } from "./lib/store";
import { styleDirective, type ResponseStyle, type StyleSurface } from "./lib/responseStyle";
import { getSettings, putSettings } from "./lib/settings";
import { currentTimeContext } from "./lib/time";
import { recordTurn, type TurnItem } from "./recordApi";
import { useTranscriptRecorder, type HydratedMessage } from "./lib/transcriptRecorder";
import {
  listConversations,
  setConversationHidden,
  setConversationPinned,
  setConversationTitle,
  type Conversation,
} from "./conversationsApi";
import { loadConversation } from "./lib/conversationLoad";
import { regenerateConversationTitle, summarizeConversationTitle } from "./lib/conversationTitle";
import type { TitleTurn } from "./lib/conversationTitle";
import { purgeTranscriptOutbox, onTranscriptRecorded } from "./transcriptApi";
import { useVisualViewport } from "./useVisualViewport";
import { api, type Me } from "./authApi";
import { friendlyAiError, micErrorMessage } from "./lib/aiError";
import { reportAiError } from "./lib/errorReport";
import { runWithSuspensionRetry } from "./lib/suspensionRetry";
import { messageBodyText, type ChatMessage, type ReplyRef } from "./types";
import { useLang } from "@/i18n/LanguageProvider";
import { aiReplyDirective } from "@/i18n/config";

const uid = () => crypto.randomUUID();

/** Small await-able delay, used by the voice-reply poll loop. */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * True when `asstId` is the reply to the MOST-RECENT voice message — i.e. the last non-errored
 * assistant message with kind "voice" in the transcript is this one.
 *
 * With the send queue, several voice (and text) messages can be in flight at once and their spoken
 * replies resolve in order. We only ever auto-play the *last* voice message's reply: an earlier one
 * stays silent while a later voice message is still outstanding (its placeholder — added the moment
 * the user sends it — already carries kind "voice", so it wins this scan). Interleaved text turns
 * carry no kind, so a voice message followed only by typed messages is still "the last voice reply"
 * and does play.
 */
function isLastVoiceReply(msgs: ChatMessage[], asstId: string): boolean {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === "assistant" && m.kind === "voice" && !m.error) return m.id === asstId;
  }
  return false;
}

// Recordings shorter than this are discarded instead of sent: a blink-quick tap-tap holds no speech,
// and transcribing/answering near-empty audio produces nonsense that derails the conversation.
const MIN_VOICE_MESSAGE_SECONDS = 0.5;

// A recording can clear the duration gate yet still hold no speech — the user tapped record, said
// nothing (or the mic caught only room tone), then tapped stop. Fed that near-silence, the transcription
// model hallucinates a plausible short phrase ("Hi.", "Thank you.") instead of returning empty, which
// lands in the user's bubble and gets answered. Require at least this much speech-level audio (see
// voicedSeconds in audio.ts) before sending; below it, drop the clip with a hint like the too-short case.
const MIN_VOICED_SECONDS = 0.15;

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
    .filter((m) => {
      if (m.error) return false;
      // A file-offer card ("I found invoice.pdf — Send it?") is UI, not conversation: neither side
      // said it, and replaying it would make the model think the exchange happened. Drop it entirely.
      if (m.kind === "fileOffer") return false;
      // Same for a forget-confirmation card: it is UI, and replaying it would have the model believe
      // the removal was already discussed and agreed.
      if (m.kind === "forgetOffer") return false;
      // Attachments only count as content on the USER side. An assistant message's `files` is a copy
      // it handed back after the user tapped Send, and those parts are deliberately NOT replayed
      // below — so a file-only assistant message would otherwise survive this filter and then produce
      // an empty `parts` array, which the API rejects.
      return m.role === "user" ? !!(m.text || m.caption || m.files?.length) : !!m.text;
    })
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [
        // The quoted-message marker precedes the text so the model reads the reply in context.
        ...(m.replyTo ? [{ text: replyContext(m.replyTo) }] : []),
        // Replay attached files inline so follow-up questions about a picture/document keep working —
        // but only the user's. A file the assistant delivered must never come back as inlineData under
        // role "model": Gemini rejects media in model output, it re-spends the inline budget on bytes
        // the model already described in words, and it would silently flip an otherwise all-text
        // conversation off the neutral server-chat path (see contentsAreTextOnly in serverChat.ts).
        ...(m.role === "user" ? (m.files ?? []).map(fileToPart) : []),
        // Typed before spoken, the order they were composed in and the order the bubble shows them.
        // Two parts rather than one joined string, so a later turn re-reads the message the same shape
        // the model was originally handed it (see runTtsVoiceTurn).
        ...(m.caption ? [{ text: m.caption }] : []),
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
  // Admin-set idle auto-hang-up window for live calls, in seconds (0 = never). Seeded from the local
  // cache so the very first call of a session doesn't fall back to the built-in default.
  const [liveIdleSec, setLiveIdleSec] = useState(store.getLiveIdleSec());
  // How voice messages are answered ("live" = one Gemini Live session — audio + text in one call, with
  // an automatic fallback to TTS on failure; "tts" = the legacy synthesis pipeline) and which Gemini
  // Live model the "live" path uses. Admin-configured; seeded from the local cache so the first voice
  // message of a session already follows the admin's policy before the config fetch resolves.
  const [voiceMode, setVoiceMode] = useState(store.getVoiceMode());
  const [voiceLiveModel, setVoiceLiveModel] = useState(store.getVoiceLiveModel());
  // Admin-set thinking level for each Live leg ("" = the model's own default). Seeded from the local
  // cache for the same reason the models above are: the first call/voice message of a session should
  // already run at the admin's chosen depth rather than reverting to the default for one turn.
  const [liveReasoning, setLiveReasoning] = useState(store.getLiveReasoning());
  const [voiceLiveReasoning, setVoiceLiveReasoning] = useState(store.getVoiceLiveReasoning());
  // The admin's primary text model isn't Gemini (e.g. ChatGPT): text turns go through the backend's
  // /api/chat/ai/text instead of the direct Gemini proxy. Session-only (re-read on every mount) and
  // defaults to false, so an old backend or a failed config fetch keeps the plain Gemini path.
  const [serverChat, setServerChat] = useState(false);
  // Whether the assistant can search the live web (an admin web-search key is configured). Session-only
  // (re-read on every mount) and defaults to false, so an old backend or a failed config fetch keeps the
  // assistant in the honest "can't browse" state and never offers the tool. See the `webSearch` flag on
  // GET /api/chat/ai/config — only this boolean crosses the wire, never the key.
  const [searchAvailable, setSearchAvailable] = useState(false);
  const [voice, setVoice] = useState(store.getVoice());
  // Chat text size, stepped from the mobile header's A− / % / A+ control. Per-browser (see the
  // store), and applied to the transcript only — chrome keeps its own sizes, so growing the text
  // buys reading area instead of eating it. Reading localStorage in the initialiser is safe here:
  // Chat only ever mounts client-side, after the auth check resolves (see page.tsx).
  const [chatScale, setChatScale] = useState(store.getChatScale());
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
  /** The conversation the user is about to remove from their history, pending confirmation. */
  const [confirmDeleteConv, setConfirmDeleteConv] = useState<string | null>(null);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteAccountError, setDeleteAccountError] = useState("");
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
    // switch (being heard on silent is the priority; the politer categories are muted by the switch).
    // The tradeoff is that "playback" interrupts other apps (Spotify) while the clip plays; we release
    // back to "auto" the instant it ends — see setAudioSessionType, which also drops the iOS
    // Now-Playing transport so the other app can reclaim it. No-op off iOS. Released only by the handle
    // that's still current, so replacing one clip with another (which re-pins "playback" just below)
    // doesn't get reset out from under the new clip.
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

  // Unlock spoken-reply auto-play at the user's FIRST gesture anywhere in the app. iOS removes the
  // reply element's play-needs-a-gesture restriction only once a play actually BEGINS inside a
  // gesture — and playback is interrupted while microphone capture is active or still settling, which
  // is why priming only on the mic press / stop tap never registered (those are exactly the moments
  // capture churn swallows it). The first tap in the app — opening the sidebar, focusing the composer,
  // even the mic button's own pointerdown, which fires before capture starts — is clean, so the prime
  // lands there. Listeners stay attached and retry on every gesture until one succeeds;
  // unlockAudioPlayback is a no-op from then on (and while a real clip is playing).
  useEffect(() => {
    const prime = () => unlockAudioPlayback();
    window.addEventListener("pointerdown", prime, { capture: true, passive: true });
    window.addEventListener("keydown", prime, { capture: true, passive: true });
    return () => {
      window.removeEventListener("pointerdown", prime, { capture: true });
      window.removeEventListener("keydown", prime, { capture: true });
    };
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
  // Echo-prone output path (iOS speaker, or the loopback failed): the session starts half duplex —
  // the mic is gated while the model speaks, so the wave doubles as a tap-to-interrupt. Speaking
  // still interrupts (the session ducks itself for a moment to check whether it's hearing the user
  // or its own speaker — see lib/bargeIn.ts); the tap is the certain way, not the only one. The gate
  // lifts itself once the mic has shown that nothing is actually echoing back (headphones, or a
  // canceller that works after all), which is re-read on every state change below. See
  // lib/echoDetector.ts.
  const [callHalfDuplex, setCallHalfDuplex] = useState(false);
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
  // The conversation a live call belongs to, captured when it starts, so each turn (and any half-finished
  // turn flushed at hang-up) is filed there even if "New chat" rotates conversationIdRef mid-call.
  const callConvIdRef = useRef<string | null>(null);
  // The in-flight Gemini Live voice message (mode "live"): held between the mic press (start) and the
  // send tap (endCapture/awaitReply). Its reply audio streams via the driver's own player.
  const liveVoiceRef = useRef<LiveVoiceMessage | null>(null);
  // The assistant bubble the current Live voice reply streams its transcript into (set at send time).
  const liveVoiceAsstIdRef = useRef<string | null>(null);
  // The human voice bubble the current Live message streams the user's own transcript into.
  const liveVoiceUserIdRef = useRef<string | null>(null);

  // Memory (recall) — background RAG only; the user-facing Memories panel is not exposed.
  const [memoryOn] = useState(true);
  const conversationIdRef = useRef(uid());
  /**
   * The key episodic summaries are written under. The SAME as the conversation id for a fresh chat, and
   * deliberately not for a resumed one.
   *
   * Writing a summary deletes every summary already stored under its key before inserting, and extraction
   * only ever sees the turns past the cursor — which, on reopening a conversation, is everything that was
   * already said. So reusing the id would have the first two new messages in a resumed chat delete that
   * conversation's summary and replace it with a summary of those two messages.
   */
  const summaryKeyRef = useRef(conversationIdRef.current);
  /**
   * Bumped every time the conversation on screen changes, and captured by each turn as it starts.
   *
   * Clearing the screen has always been enough to neutralise a turn still in flight: its writes target a
   * bubble by id and simply found nothing. That stops being true the moment a conversation can be
   * reopened, because reopening restores the very ids it was looking for — so a turn abandoned on an
   * earlier visit would come back to life and write into the reloaded chat. The epoch is what tells it
   * that the chat it was talking to is gone even when its bubbles are on screen again.
   */
  const turnEpochRef = useRef(0);
  // The history list in the sidebar. Owned here rather than in the list component, which is mounted twice
  // (a desktop rail and a mobile overlay) and would otherwise load and remember everything in duplicate.
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  // Which conversation the list should mark as the one you're in. Null while a new chat is still empty —
  // it isn't in the list yet, because nothing has been said in it to record.
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  // Conversations this tab has already tried to name, so a failed attempt costs one call rather than one
  // per recorded message. Naming is once-per-conversation; the server's `named` flag covers reloads.
  const titledRef = useRef(new Set<string>());

  // Derived profile ("what the AI knows about you"): loaded once, injected into every chat, and
  // refreshed after each extraction. Refs (+ store getters) so the unload/idle handlers see live state.
  const profileFactsRef = useRef<Fact[]>([]);
  const tasksRef = useRef<Task[]>([]);
  const statesRef = useRef<UserState[]>([]);
  const eventsRef = useRef<LifeEvent[]>([]);
  const extractCursorRef = useRef(0); // messages already distilled into the profile this conversation
  const extractTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A distillation is in flight. Guards the debounce, the end of a call and the tab-hide handler from
  // racing each other; `extractRerunRef` remembers a request that arrived while one was running so it
  // runs afterwards rather than being dropped.
  const extractInFlightRef = useRef(false);
  const extractRerunRef = useRef<{ minNew: number; maxTurns?: number } | null>(null);
  // Civil day the recurrence catch-up last ran for, so a tab left open past midnight still rolls
  // repeating tasks onto the new day before the next reply is composed.
  const lastCatchUpDayRef = useRef<string>("");

  // --- Message store + serial send queue ---
  //
  // `messagesRef` is the AUTHORITATIVE, synchronously-updated copy of the transcript; `messages`
  // state trails it by a render (React commits async). Because the user can now queue several
  // messages before the first reply lands, each queued turn must build its prompt from the reply the
  // PREVIOUS queued turn just produced — which may not have been committed to React state yet. So
  // every mutation goes through `applyMessages`, which updates the ref first and then mirrors it into
  // state. Nothing else calls setMessages directly (that would let the ref drift out of sync).
  const messagesRef = useRef<ChatMessage[]>([]);
  const applyMessages = useCallback((updater: (cur: ChatMessage[]) => ChatMessage[]) => {
    // Stamp anything that arrived without a time. Doing it at the one door every message comes through
    // beats adding a field to the dozen places a bubble is built — and it can't be forgotten by the
    // next one. Messages that already carry a time (a reopened conversation's) keep it.
    //
    // Checked before rewriting: this runs on every streamed token, and mapping unconditionally would
    // rebuild every message object in a long transcript once per word revealed.
    const next = updater(messagesRef.current);
    const now = new Date().toISOString();
    messagesRef.current = next.some((m) => !m.at) ? next.map((m) => (m.at ? m : { ...m, at: now })) : next;
    setMessages(messagesRef.current);
  }, []);

  // The transcript as it stood just before `boundaryId` — the history a queued turn feeds to the
  // model. Since turns run strictly in order, everything ahead of the boundary is already finalized.
  // If the boundary is gone (its bubble was deleted, or the chat was cleared while the turn was still
  // queued), return an EMPTY history rather than the whole current transcript — which could otherwise
  // splice in later, unrelated in-flight turns.
  const historyBefore = useCallback((boundaryId: string, epoch: number): ChatMessage[] => {
    // Reopening a conversation puts the same ids back on screen, so "the boundary is gone" no longer
    // means what it did — an abandoned turn would find its boundary again and build a prompt out of
    // freshly loaded history. The epoch says whether this turn's chat is still the one being shown.
    if (turnEpochRef.current !== epoch) return [];
    const msgs = messagesRef.current;
    const i = msgs.findIndex((m) => m.id === boundaryId);
    return i === -1 ? [] : msgs.slice(0, i);
  }, []);

  // FIFO queue for AI turns: the user's bubble + a "typing" placeholder are shown immediately (so the
  // composer never blocks), but the actual generation for each turn runs only after the previous one
  // finishes streaming its TEXT. Chaining off a tail promise keeps responses in send order; each task
  // owns its own error handling, and the trailing catch is just a backstop so one failure can't wedge
  // the chain. (Spoken-audio synthesis is detached inside runAssistant, so TTS never holds the queue.)
  const queueTailRef = useRef<Promise<void>>(Promise.resolve());
  const enqueueTurn = useCallback((task: () => Promise<void>) => {
    queueTailRef.current = queueTailRef.current.then(task).catch(() => {});
  }, []);

  // Live mirrors of call/mic state for the async auto-play decision (see applyVoiceAudio), which runs
  // outside render and must read the latest value, not a stale closure. inCallRef is set synchronously
  // when a call starts (see startCall) so a reply resolving during connect can't play over it; this
  // effect keeps it truthful for every other callState transition (its one-commit lag on the way OUT
  // only makes auto-play a touch more conservative).
  const inCallRef = useRef(false);
  useEffect(() => {
    inCallRef.current = !!callState;
  }, [callState]);

  // The verbatim conversation record: every message on screen, both sides, recorded as text. Driven off
  // the message list rather than the send/reply path so it also captures what turn bookkeeping drops —
  // a user message whose reply then failed, the error the assistant showed instead, and a call that
  // ended mid-sentence. Independent of memory/recall (recordTextTurns), which stays exactly as it was.
  const hydrateRecorder = useTranscriptRecorder(
    messages,
    // A message appearing during a call belongs to the call's own conversation, which survives a
    // "New chat" mid-call; everything else belongs to the conversation on screen.
    useCallback(() => (inCallRef.current && callConvIdRef.current) || conversationIdRef.current, []),
    useCallback(() => inCallRef.current, []),
  );
  // True from the instant the user taps the mic — through the async getUserMedia acquisition and the
  // whole recording — until the clip has been captured and queued. Managed by hand (NOT mirrored from
  // `voiceState`, which only flips to "recording" AFTER acquisition) so it already covers the
  // acquisition window; the auto-play gate reads it to keep a resolving reply from playing through the
  // speaker into a recording that is just starting.
  const micBusyRef = useRef(false);

  const refreshProfile = useCallback(async () => {
    if (!store.getMemoryOn()) return;
    profileFactsRef.current = await getProfile();
  }, []);

  const refreshStates = useCallback(async () => {
    if (!store.getMemoryOn()) return;
    statesRef.current = await getStates();
  }, []);

  const refreshEvents = useCallback(async () => {
    if (!store.getMemoryOn()) return;
    eventsRef.current = await getEvents("open");
  }, []);

  const refreshTasks = useCallback(async () => {
    if (!store.getMemoryOn()) return;
    // Rolling overdue repeating tasks forward happens here and nowhere else — there is no timer and no
    // server sweep, so the refresh path IS the recurrence clock. That's enough because a reminder can
    // only ever surface while the user is actually here.
    const fresh = await getTasks("open");
    tasksRef.current = fresh;
    lastCatchUpDayRef.current = localDateStr();
    tasksRef.current = await catchUpRecurring(fresh);
  }, []);

  /** Re-run the recurrence catch-up if the civil day has changed since the last one — covers a tab
   * left open across midnight, where nothing else would notice that "tomorrow" is now today. */
  const catchUpIfNewDay = useCallback(async () => {
    if (!store.getMemoryOn()) return;
    if (lastCatchUpDayRef.current === localDateStr()) return;
    await refreshTasks();
  }, [refreshTasks]);

  // Distil new turns into the profile (fire-and-forget; never blocks chat). `minNew` guards against
  // extracting tiny fragments — a closing conversation needs one exchange, an idle tick needs more.
  // `maxTurns` widens the window for a voice call, which emits far more (and far shorter) turns than
  // typing does and would otherwise lose everything before the last 20.
  const runExtraction = useCallback(async (minNew = 2, maxTurns?: number) => {
    if (!store.getMemoryOn()) return;
    // Three triggers can now fire at once (the debounce, the end of a call, and the tab being
    // hidden). Without a lock they race and each pays for its own extraction; but simply dropping
    // the loser would silently skip the end-of-call distillation whenever the debounce beat it to
    // the punch — the exact case this work exists to fix. So queue it and drain below instead.
    if (extractInFlightRef.current) {
      extractRerunRef.current = { minNew, maxTurns };
      return;
    }

    const once = async (min: number, cap?: number) => {
      // Trim-aware, matching how extractAndSyncProfile filters: a whitespace-only bubble (a live
      // transcript can emit one) would otherwise be counted here but dropped there, drifting the
      // cursor away from the window it indexes into. Filter and map read through the same
      // messageBodyText for that reason — and so the typed half of a voice message gets distilled too.
      const transcript = messagesRef.current
        .filter((m) => messageBodyText(m).trim() && !m.error && !m.streaming)
        .map((m) => ({ role: m.role, text: messageBodyText(m) }));
      if (transcript.length - extractCursorRef.current < min) return;
      const sinceIndex = extractCursorRef.current;
      extractCursorRef.current = transcript.length;
      const delta = await extractAndSyncProfile({
        model: store.getTextModel(),
        // The summary key, not the conversation id — they differ for a resumed chat (see summaryKeyRef).
        conversationId: summaryKeyRef.current,
        currentFacts: profileFactsRef.current,
        currentTasks: tasksRef.current,
        currentEvents: eventsRef.current,
        transcript,
        sinceIndex,
        maxTurns: cap,
      });
      // A failed call (offline, 429, bad JSON) must NOT count as distilled: the cursor was advanced
      // optimistically above, so rewind it — otherwise one blip at the end of a long call marks the
      // whole conversation done forever and it is never retried.
      if (delta?.failed) {
        extractCursorRef.current = Math.min(extractCursorRef.current, sinceIndex);
        return;
      }
      if (delta?.profileChanged) await refreshProfile();
      if (delta?.tasksChanged) await refreshTasks();
      if (delta?.statesChanged) await refreshStates();
      if (delta?.eventsChanged) await refreshEvents();
      // Amortised narrative rollup: there is no scheduler, so a completed week gets its digest the
      // next time a conversation is distilled. Detached — it must never delay the chat, and it
      // swallows its own failures.
      void maybeRollupDigests(store.getTextModel());
    };

    extractInFlightRef.current = true;
    try {
      let job: { minNew: number; maxTurns?: number } | null = { minNew, maxTurns };
      while (job) {
        await once(job.minNew, job.maxTurns);
        job = extractRerunRef.current;
        extractRerunRef.current = null;
      }
    } finally {
      extractInFlightRef.current = false;
    }
  }, [refreshProfile, refreshTasks, refreshStates, refreshEvents]);

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
        liveIdleTimeoutSeconds?: number; voiceLiveModel?: string; voiceMode?: string; webSearch?: boolean;
        liveReasoning?: string | null; voiceLiveReasoning?: string | null;
      };
      if (cfg.textModel) { store.setTextModel(cfg.textModel); setTextModel(cfg.textModel); }
      if (cfg.audioModel) { store.setAudioModel(cfg.audioModel); setAudioModel(cfg.audioModel); }
      if (cfg.liveModel) { store.setLiveModel(cfg.liveModel); setLiveModel(cfg.liveModel); }
      if (cfg.defaultVoice && !store.getVoiceChosen()) { store.setVoice(cfg.defaultVoice); setVoice(cfg.defaultVoice); }
      // 0 = "never auto-hang-up", so check for a number rather than truthiness. An older backend that
      // doesn't send the field leaves the cached/default window in place.
      if (typeof cfg.liveIdleTimeoutSeconds === "number" && cfg.liveIdleTimeoutSeconds >= 0) {
        store.setLiveIdleSec(cfg.liveIdleTimeoutSeconds);
        setLiveIdleSec(cfg.liveIdleTimeoutSeconds);
      }
      // Voice-message policy. Additive: an older backend omits these, so the cached/default (Live) stays.
      if (cfg.voiceMode === "live" || cfg.voiceMode === "tts") {
        store.setVoiceMode(cfg.voiceMode);
        setVoiceMode(cfg.voiceMode);
      }
      if (cfg.voiceLiveModel) { store.setVoiceLiveModel(cfg.voiceLiveModel); setVoiceLiveModel(cfg.voiceLiveModel); }
      // Live thinking levels. null is a real value here ("auto" — the admin cleared it), so these are
      // applied whenever the key is PRESENT rather than truthy, letting a clear propagate. An older
      // backend omits the keys entirely (undefined), which leaves the cached value alone.
      if (cfg.liveReasoning !== undefined) {
        store.setLiveReasoning(cfg.liveReasoning ?? "");
        setLiveReasoning(store.getLiveReasoning());
      }
      if (cfg.voiceLiveReasoning !== undefined) {
        store.setVoiceLiveReasoning(cfg.voiceLiveReasoning ?? "");
        setVoiceLiveReasoning(store.getVoiceLiveReasoning());
      }
      setServerChat(!!cfg.serverChat);
      setSearchAvailable(!!cfg.webSearch);
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
    void refreshStates();
    void refreshEvents();
    return () => { settingsActiveRef.current = false; };
  }, [loadConfig, loadSettings, refreshProfile, refreshTasks, refreshStates, refreshEvents]);

  // Distil the conversation when the user backgrounds or leaves the tab — a natural "conversation end".
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void runExtraction(2);
      // Coming back to a tab that was left open overnight: re-roll repeating tasks onto today.
      else void catchUpIfNewDay();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
      if (extractTimerRef.current) clearTimeout(extractTimerRef.current);
    };
  }, [runExtraction, catchUpIfNewDay]);

  function pickVoice(v: string) {
    store.setVoice(v);
    setVoice(v);
  }

  function pickChatScale(v: number) {
    store.setChatScale(v);
    setChatScale(v);
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

  // Typed replies are never voiced automatically (that would spend tokens on audio nobody asked to
  // hear) — the user taps "Play" to synthesize on demand. These ids are mid-synthesis right now: the
  // ref is the authoritative copy the async loop dedupes against; the state drives the button's
  // loading spinner. Kept in sync by markGenerating below.
  const generatingAudioRef = useRef<Set<string>>(new Set());
  const [generatingAudio, setGeneratingAudio] = useState<ReadonlySet<string>>(generatingAudioRef.current);
  const markGenerating = (id: string, on: boolean) => {
    const next = new Set(generatingAudioRef.current);
    if (on) next.add(id);
    else next.delete(id);
    generatingAudioRef.current = next;
    setGeneratingAudio(next);
  };

  // Attach a finished spoken clip to its reply and reveal the text. Guarded so a late arrival can't
  // clobber a reply that was already resolved (or deleted). Auto-play is deliberately narrow: with a
  // queue of messages in flight we only ever speak the LAST voice message's reply, and only when the
  // audio path is actually free.
  const applyVoiceAudio = useCallback(
    (asstId: string, audio: VoiceReplyAudio) => {
      // Decide auto-play from the ref, NOT from a flag set inside the updater: React batches updates
      // from async contexts like this poll callback, so a deferred updater would leave the flag stale.
      // The authoritative ref always reflects the latest transcript, so the decision is deterministic.
      const snapshot = messagesRef.current;
      const target = snapshot.find((m) => m.id === asstId);
      const stillPending = !!target && !!target.pendingAudio && !target.audio;
      applyMessages((cur) =>
        cur.map((m) =>
          m.id === asstId && m.pendingAudio && !m.audio
            ? { ...m, streaming: false, pendingAudio: false, audio }
            : m,
        ),
      );
      // Auto-play only when every condition holds:
      //  - the clip was still pending (not already resolved/deleted),
      //  - the tab is foreground (an un-gestured clip won't play to a hidden tab; iOS blocks it),
      //  - no realtime call is running (the call owns the speaker — the Play button covers it later),
      //  - the mic is idle (playing while recording would feed the assistant's voice into the clip),
      //  - this is the reply to the most-recent voice message (an earlier one stays silent while a
      //    later voice message is still outstanding — that's the "only play the last one" rule).
      const foreground = typeof document !== "undefined" && document.visibilityState === "visible";
      if (
        stillPending &&
        foreground &&
        !inCallRef.current &&
        !micBusyRef.current &&
        isLastVoiceReply(snapshot, asstId)
      ) {
        playAudioClip(asstId, audio.base64, audio.sampleRate);
      }
    },
    [playAudioClip, applyMessages],
  );

  // Give up on a reply's spoken audio: reveal its text without a clip (the same end state a TTS failure
  // has always produced). No-op once the reply is no longer waiting on audio.
  const revealWithoutAudio = useCallback(
    (asstId: string) => {
      applyMessages((cur) =>
        cur.map((m) => (m.id === asstId && m.pendingAudio ? { ...m, streaming: false, pendingAudio: false } : m)),
      );
    },
    [applyMessages],
  );

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
          if (!msg || !msg.pendingAudio || msg.audio) return; // resolved, deleted, or chat cleared
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

  // --- On-demand spoken audio for typed replies (never auto-synthesized, to save tokens) ---

  // Synthesize `text` as the spoken clip for reply `replyId` and return it (or null on failure).
  // Reuses the same server-side pipeline as the voice-message path (which survives a backgrounded
  // tab — see ensureVoiceReplyAudio), falling back to in-browser TTS when that endpoint is missing
  // or the kickoff fails. `isStale` lets the caller bail if the bubble is deleted mid-synthesis.
  async function synthesizeReplyOnDemand(
    replyId: string,
    text: string,
    isStale: () => boolean,
  ): Promise<VoiceReplyAudio | null> {
    const voice = store.getVoice();
    try {
      if (!(await startVoiceReply(replyId, text, voice))) {
        // Endpoint missing / request failed → in-browser fallback so the reply still gets a voice.
        try {
          return await synthesizeSpeech(audioModel, text, voice);
        } catch {
          return null;
        }
      }
      let visibleAttempts = 0;
      const maxVisibleAttempts = 75; // ~75s of FOREGROUND polling; a synthesis normally lands in a few
      for (;;) {
        if (isStale()) return null; // the bubble was deleted / the chat was cleared
        if (typeof document !== "undefined" && document.hidden) {
          await sleep(1000); // tab suspended — wait without spending the budget
          continue;
        }
        const res = await fetchVoiceReply(replyId);
        if (res.status === "ready") return { base64: res.base64, sampleRate: res.sampleRate };
        if (res.status === "failed") return null;
        if (res.status === "unknown") await startVoiceReply(replyId, text, voice); // lost/swept — re-kick
        if (++visibleAttempts >= maxVisibleAttempts) return null;
        await sleep(1000);
      }
    } catch {
      return null;
    }
  }

  // Tapping "Play" on a typed reply that has no clip yet: synthesize it, attach it to the bubble (so
  // a second listen doesn't re-synthesize and the button turns into a normal play/pause control),
  // then play it once. Deduped so a double-tap can't spawn two synthesis loops for the same reply.
  async function generateAndPlayReplyAudio(m: ChatMessage) {
    const id = m.id;
    const text = m.text.trim();
    if (!text || generatingAudioRef.current.has(id)) return;
    // The tap that triggered this is a user gesture, and synthesis takes a beat — prime iOS
    // spoken-reply playback now (synchronously, before the awaited synthesis) so the clip can play
    // when it lands seconds later without needing its own tap. Best-effort; the button plays it
    // directly on a later tap if this doesn't land. Mirrors the mic-press priming in startVoice.
    try {
      unlockAudioPlayback();
    } catch {
      /* playback priming is best-effort — the clip still plays when the button is tapped again */
    }
    markGenerating(id, true);
    try {
      const isStale = () => !messagesRef.current.some((x) => x.id === id);
      const audio = await synthesizeReplyOnDemand(id, text, isStale);
      if (!audio || isStale()) return;
      applyMessages((cur) => cur.map((x) => (x.id === id ? { ...x, audio } : x)));
      // Play now unless the audio path was taken over while we were synthesizing (a call started,
      // the mic opened, or the tab went to the background) — the ready "Play" button covers those.
      const foreground = typeof document !== "undefined" && document.visibilityState === "visible";
      if (foreground && !inCallRef.current && !micBusyRef.current) {
        playAudioClip(id, audio.base64, audio.sampleRate);
      }
    } finally {
      markGenerating(id, false);
    }
  }

  // The bubble's audio button. A reply that already has a clip (a voice-message reply, or a text
  // reply voiced on an earlier tap) plays / pauses / resumes it; a typed reply without one
  // synthesizes on demand first. Passed to MessageList as onPlayAudio.
  function handlePlayReplyAudio(m: ChatMessage) {
    if (m.audio) playAudio(m);
    else void generateAndPlayReplyAudio(m);
  }

  // --- Stored files: the assistant offers one, the user decides whether it lands in the chat ---

  // The `send_file` tool found a stored file and wants to give it back. This does NOT deliver it: it
  // posts a confirmation card into the chat, and nothing is fetched until the user confirms it (see
  // sendStoredFile). The model's optional `note` becomes the card's caption; without one the card just
  // carries its own label, and the model's reply ("I found your invoice…") reads as the sentence above it.
  //
  // Idempotent per file: runWithSuspensionRetry re-runs the WHOLE turn after an iOS tab suspension, tool
  // calls included, and it only resets the assistant message's text — cards appended by the first attempt
  // survive. Without this guard the user comes back to the same file offered twice.
  const offerFile = useCallback(
    (meta: StoredFileMeta, note?: string) => {
      applyMessages((cur) =>
        cur.some((m) => m.kind === "fileOffer" && m.fileRef?.id === meta.id)
          ? cur
          : [...cur, { id: uid(), role: "assistant", text: note ?? "", kind: "fileOffer", fileRef: meta }],
      );
    },
    [applyMessages],
  );

  // The `send_link` tool wants to hand the user a URL. It lands as an ordinary assistant message whose
  // text is the link — MessageList renders through react-markdown + remark-gfm, so it comes out as a real
  // tappable anchor with no new message kind or renderer needed.
  //
  // This exists because a SPOKEN reply's text is the transcription of its own audio: the model cannot show
  // an address without also reading it out. Posting a separate message is what lets it say "here's the
  // link" briefly and still leave something clickable behind.
  //
  // Same idempotency guard as offerFile, for the same reason: runWithSuspensionRetry replays a whole turn
  // after an iOS tab suspension, and only the assistant message's text is reset — so without this the user
  // returns to the same link posted twice.
  const postLink = useCallback(
    (link: OutgoingLink) => {
      const text = linkMarkdown(link);
      applyMessages((cur) =>
        cur.some((m) => m.role === "assistant" && m.text === text)
          ? cur
          : [...cur, { id: uid(), role: "assistant", text }],
      );
    },
    [applyMessages],
  );

  // The `forget_memories` tool wants to remove things from memory. Like offerFile this does NOT act:
  // it posts a card listing exactly what would go, and the deletion happens only if the user taps it
  // (see confirmForget). Same idempotency guard, keyed on the set of refs, so an iOS suspension replay
  // can't stack two identical cards.
  const offerForget = useCallback(
    (items: ForgetItem[], note: string) => {
      const sig = items.map((i) => i.ref).join(",");
      applyMessages((cur) =>
        cur.some((m) => m.kind === "forgetOffer" && (m.forgetRef ?? []).map((i) => i.ref).join(",") === sig)
          ? cur
          : [...cur, { id: uid(), role: "assistant", text: note, kind: "forgetOffer", forgetRef: items }],
      );
    },
    [applyMessages],
  );

  // The user tapped the confirm button on a forget card — THIS is the deletion; nothing was removed
  // before now. Facts are also tombstoned inside applyForget so the conversation in which they asked
  // can't re-teach them on the next extraction. The card becomes a plain confirmation line either way.
  const confirmForget = useCallback(
    async (messageId: string, items: ForgetItem[]) => {
      const facts = profileFactsRef.current.map((f) => ({ id: f.id, category: f.category, key: f.key }));
      let removed = 0;
      try {
        removed = await applyForget(items, facts);
      } catch {
        /* fall through — the card still resolves, and nothing is silently left half-offered */
      }
      await refreshProfile();
      applyMessages((cur) =>
        cur.map((m) =>
          m.id === messageId
            ? { ...m, kind: undefined, forgetRef: null, text: removed > 0 ? t.message.forgetDone : t.message.fileUnavailable }
            : m,
        ),
      );
    },
    [applyMessages, refreshProfile, t],
  );

  // The user tapped Send on an offer card. Pull the stored bytes back down and turn the card itself
  // into a normal assistant message carrying the file, so it renders exactly like a fresh attachment
  // (thumbnail + lightbox, or a chip). Clearing `kind`/`fileRef` is what retires the card; on a failed
  // fetch the same message becomes a plain error line, so the card can't be left stuck mid-send.
  const sendStoredFile = useCallback(
    async (messageId: string, fileId: number) => {
      const pf = await fetchChatFileContent(fileId);
      applyMessages((cur) =>
        cur.map((m) =>
          m.id !== messageId
            ? m
            : pf
              ? { ...m, kind: undefined, fileRef: null, files: [pf] }
              : { ...m, kind: undefined, fileRef: null, error: true, text: t.message.fileUnavailable },
        ),
      );
    },
    [t, applyMessages],
  );

  // `isCurrent` guards the one write that APPENDS a new bubble mid-turn — the send_file offer card.
  // (Streamed text and the finalizers only `.map` an existing message, so they no-op once it's gone.)
  // A turn abandoned by "New chat" keeps running, so without this its tool call could drop a card into
  // the fresh conversation.
  async function runAssistant(
    asstId: string,
    contents: Content[],
    speak: boolean,
    isCurrent: () => boolean = () => true,
    // The transcript slice this turn is grounded in — used to pick the screenshot for record_suggestion.
    // Defaults to the whole transcript; queued turns pass their own history so a LATER queued message's
    // image can't be attached to THIS turn's suggestion.
    scopedHistory: () => ChatMessage[] = () => messagesRef.current,
    // What the user actually said this turn, read at check time rather than passed by value — the
    // spoken paths only have their transcript once it lands, which is well before this is needed.
    // Used solely to decide whether an explicit "put this on my list" went untracked (see below).
    userText: () => string = () => "",
    // Relevant notes recalled from earlier conversations (RAG), or null. Goes into the SYSTEM
    // instruction beside the other grounding blocks — never into `contents`. As a user turn sitting
    // right before the real message it was indistinguishable from one, and an old "add this to my
    // to-do list" quoted inside it got answered in place of what the user had just asked for.
    // See lib/recall.ts.
    recalledNotes: string | null = null,
  ): Promise<string> {
    let acc = "";
    const onDelta = (delta: string) => {
      acc += delta;
      applyMessages((cur) => cur.map((m) => (m.id === asstId ? { ...m, text: acc } : m)));
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
      runSuggestionTool(args, () => sharedSuggestionImages(scopedHistory()));
    // When the admin's primary text model isn't Gemini, run the turn server-side — but only for
    // all-text conversations: inline media (images / PDFs / voice clips, replayed in history) needs
    // Gemini's multimodal input, so those turns stay on the direct proxy path.
    const stream = (sys: string, tools: Tool[], runTool: ToolExecutor, msgs: Content[] = contents) =>
      serverChat && contentsAreTextOnly(msgs)
        ? streamServerChatWithTools(toNeutralMessages(msgs), sys, tools, runTool)
        : streamTextWithTools(textModel, msgs, sys, tools, runTool);
    // Every to-do change this turn actually made, straight from the tool responses. The reply is
    // checked against it once the text has finished (see buildTaskReceipt below) so a change the model
    // forgot to mention still reaches the user — the reported failure was a first message asking for
    // something to go on the list and getting back a greeting, with no way to tell whether it had.
    const taskChanges: TaskChange[] = [];
    // Did they plainly ask for something to go on the list this turn? Decided once, read again after
    // the recheck round below, so the receipt can state outright that nothing did. Only meaningful on
    // the memory-on path — that's the only one with task tools at all.
    let askedToAdd = false;
    if (memoryOn) {
      // A tab open since yesterday still holds yesterday's agenda; roll repeating tasks onto today
      // before the block below is rendered, or the model is told a chore is overdue when it is due now.
      await catchUpIfNewDay();
      // Ground the reply in the durable profile (who the user is) + today's task agenda + persona +
      // current time. The agenda is re-rendered every turn, so task tool calls show up mid-conversation.
      const sys = [
        renderProfileBlock(profileFactsRef.current),
        renderStateBlock(statesRef.current),
        renderEventsBlock(eventsRef.current),
        renderAgendaBlock(tasksRef.current),
        // Recalled past conversations go here, AFTER the authoritative task list and clearly labelled
        // as background — not into the conversation, where an instruction quoted in a note reads as a
        // live one (see lib/recall.ts for the failure this ordering exists to prevent).
        recalledNotes,
        // Directly after the blocks that invite the assistant to raise something itself: whatever they
        // suggest, the user's message is what the reply is for. Without this the model would answer a
        // plain question with a check-in about their week and never get to the question at all.
        ANSWER_FIRST,
        // Immediately after it, against the same blocks: every one of them is re-injected verbatim on
        // every turn, so without this the reply to "what else?" is the previous reply again.
        NO_REPETITION,
        langDirective,
        styleDir,
        // Right before the identity block, because it's the same subject: what the assistant is
        // called. This path answers spoken clips too (the classic voice turn sends the raw audio
        // here), and "EverVault" is the word recognition mangles most — see brandName.ts.
        BRAND_NAME_HEARING,
        CONFIDENTIALITY,
        CAPABILITY_BOUNDS,
        // Exactly one of these always survives .filter(Boolean): tell the model it can search the web
        // when a key is configured, or that it can't right now when it isn't.
        searchAvailable ? SEARCH_PERSONA_AVAILABLE : SEARCH_PERSONA_UNAVAILABLE,
        // Reading a page needs no key, so unlike search this is unconditional.
        URL_FETCH_PERSONA,
        LINK_PERSONA,
        SAFETY_BOUNDS,
        MEMORY_PERSONA,
        FILES_PERSONA,
        TASKS_PERSONA,
        FORGET_PERSONA,
        SUGGESTION_PERSONA,
        currentTimeContext(),
      ]
        .filter(Boolean)
        .join("\n\n");
      const tools = [
        {
          functionDeclarations: [
            RECALL_MEMORY_DECLARATION,
            ...TASK_TOOL_DECLARATIONS,
            ...FILE_TOOL_DECLARATIONS,
            ...FORGET_TOOL_DECLARATIONS,
            RECORD_SUGGESTION_DECLARATION,
            // Only offered when a web-search key is configured; the persona above matches this.
            ...(searchAvailable ? [SEARCH_WEB_DECLARATION] : []),
            // Always offered: reading a page is keyless, so there is nothing to gate it on.
            FETCH_URL_DECLARATION,
            SEND_LINK_DECLARATION,
          ],
        },
      ];
      // The last arm is a fallthrough, not a name match — recall_memory is whatever didn't match
      // above. So every new tool family needs its own explicit arm ahead of it, or its calls get
      // silently answered by a memory search.
      const runTool = (name: string, args: Record<string, unknown>) =>
        isSuggestionTool(name)
          ? runSuggestion(args)
          : isTaskTool(name)
            ? runTaskTool(
                name,
                args,
                (change) => {
                  if (change) taskChanges.push(change);
                  void refreshTasks();
                },
                conversationIdRef.current,
              )
            : isFileTool(name)
              ? runFileTool(name, args, (meta, note) => {
                  if (isCurrent()) offerFile(meta, note);
                })
              : isForgetTool(name)
                ? runForgetTool(name, args, (items, note) => {
                    if (isCurrent()) offerForget(items, note);
                  })
                : isWebSearchTool(name)
                  ? runWebSearchTool(args)
                  : isUrlFetchTool(name)
                    ? runUrlFetchTool(args)
                    : isLinkTool(name)
                      ? runSendLinkTool(args, (l) => {
                          if (isCurrent()) postLink(l);
                        })
                      : runRecallTool(args);
      for await (const delta of stream(sys, tools, runTool)) {
        onDelta(delta);
      }
      // Two ways this turn can have mishandled the list, both worth ONE more round: an explicit "add
      // this to my to-do list" that finished without add_task ever being called (nothing saved, so the
      // receipt has nothing to report), or a task that was saved but matches nothing in the
      // conversation — the shape of the mophiqo/locksmith report, where a request recalled from an
      // earlier session was acted on instead of the live one. Code decides WHEN; the nudge only states
      // the fact and hands the judgement back. See lib/taskIntent.ts.
      askedToAdd = asksToTrackSomething(userText());
      const nudge = buildRecheckNudge({
        userText: userText(),
        addedTitles: taskChanges.filter((c) => c.kind === "added").flatMap((c) => c.tasks.map((x) => x.title)),
        // An add refused because the task was already there is a HANDLED request, not a missed one:
        // without this the untracked-request nudge would fire on "nothing saved" and push the model
        // into adding the very duplicate the check just stopped.
        duplicateTitles: taskChanges
          .filter((c) => c.kind === "duplicate")
          .flatMap((c) => c.tasks.map((x) => x.title)),
        // Everything said this conversation THROUGH the user's latest message — deliberately not the
        // reply being composed, whose whole problem is that it names the stray task.
        conversation: scopedHistory().map(messageBodyText).join("\n"),
        notes: recalledNotes,
      });
      if (nudge) {
        const followUp: Content[] = [
          ...contents,
          { role: "model", parts: [{ text: acc || "(no reply)" }] },
          { role: "user", parts: [{ text: nudge }] },
        ];
        // Buffered rather than streamed into the bubble: the first reply stays on screen behind the
        // typing dots and is only replaced once the retry has actually produced something, so a retry
        // that fails or comes back empty can't blank out an answer the user already had.
        let retry = "";
        try {
          for await (const delta of stream(sys, tools, runTool, followUp)) {
            retry += delta;
          }
        } catch {
          /* the first reply stands — a failed second opinion must never cost the user the first */
        }
        if (retry.trim()) {
          acc = retry;
          applyMessages((cur) => cur.map((m) => (m.id === asstId ? { ...m, text: acc } : m)));
        }
      }
    } else {
      const sys = [
        langDirective,
        styleDir,
        BRAND_NAME_HEARING, // same reason as the memory-on arm above
        CONFIDENTIALITY,
        CAPABILITY_BOUNDS,
        searchAvailable ? SEARCH_PERSONA_AVAILABLE : SEARCH_PERSONA_UNAVAILABLE,
        URL_FETCH_PERSONA,
        LINK_PERSONA,
        SUGGESTION_PERSONA,
        currentTimeContext(),
      ]
        .filter(Boolean)
        .join("\n\n");
      const tools = [
        {
          functionDeclarations: [
            RECORD_SUGGESTION_DECLARATION,
            ...(searchAvailable ? [SEARCH_WEB_DECLARATION] : []),
            FETCH_URL_DECLARATION,
            SEND_LINK_DECLARATION,
          ],
        },
      ];
      const runTool = (name: string, args: Record<string, unknown>) =>
        isWebSearchTool(name)
          ? runWebSearchTool(args)
          : isUrlFetchTool(name)
            ? runUrlFetchTool(args)
            : isLinkTool(name)
              ? runSendLinkTool(args, (l) => {
                  if (isCurrent()) postLink(l);
                })
              : runSuggestion(args);
      for await (const delta of stream(sys, tools, runTool)) {
        onDelta(delta);
      }
    }
    // Close the loop on anything the reply changed but never said. Appended BEFORE the voice branch on
    // purpose: `acc` is what gets synthesised, so a spoken reply says it out loud too rather than
    // showing text its own audio doesn't contain. Silent when the model did confirm the change itself.
    const receipt = buildTaskReceipt(taskChanges, acc, t, lang, askedToAdd);
    if (receipt) {
      acc = acc ? `${acc}\n\n${receipt}` : receipt;
      applyMessages((cur) => cur.map((m) => (m.id === asstId ? { ...m, text: acc } : m)));
    }
    const finalText = acc || "_(no response)_";
    if (speak && acc) {
      // Voice reply: the text has fully streamed in, but keep it behind the "typing" dots (pendingAudio)
      // until the spoken audio is ready, so the reply lands as text + voice together instead of the text
      // racing ahead of the slower TTS. Synthesis runs SERVER-SIDE now (see ensureVoiceReplyAudio): the
      // backend generates the voice on a worker that keeps going even if the tab is backgrounded — the
      // exact case where the old in-page TTS was killed and the reply came back voiceless. Detached, so
      // the caller settles immediately; `pendingAudio` gates only auto-play now, not the composer.
      applyMessages((cur) => cur.map((m) => (m.id === asstId ? { ...m, streaming: false, text: finalText } : m)));
      void ensureVoiceReplyAudio(asstId, acc);
    } else {
      applyMessages((cur) =>
        cur.map((m) => (m.id === asstId ? { ...m, streaming: false, pendingAudio: false, text: finalText } : m)),
      );
    }
    return acc;
  }

  // --- Memory: record finished turns + pull relevant memories into context (RAG) ---

  async function recordTextTurns(
    items: { role: "user" | "assistant"; text: string; modality: "text" | "voice" | "live" | "image" }[],
    extra?: { audioBase64?: string; imageBase64?: string; imageMime?: string },
    // The conversation this exchange belongs to. Queued turns pass the id captured when the user sent
    // the message, so a reply that only resolves AFTER "New chat" is filed under the old conversation
    // (where it belongs) instead of leaking into the fresh one. Defaults to the current conversation.
    conversationId?: string,
  ) {
    if (!memoryOn) return;
    const convId = conversationId ?? conversationIdRef.current;
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
    recordTurn(convId, turns);
    // Only re-arm distillation for the LIVE conversation — a late turn from a cleared chat shouldn't
    // schedule an extraction against the new one.
    if (convId === conversationIdRef.current) scheduleExtraction();
  }

  /** Relevant past context (episodic summaries + turns, re-ranked) as a grounding block for the next
   *  reply's system instruction — NOT a conversation turn; see lib/recall.ts.
   *  `history` is this turn's slice of the transcript (everything before it), so a queued turn re-ranks
   *  against what actually precedes it rather than whatever else is in flight behind it. */
  async function ragNotes(query: string, history: ChatMessage[]): Promise<string | null> {
    if (!memoryOn) return null;
    const recent = history
      .filter((m) => !m.error && messageBodyText(m))
      .map((m) => ({ role: m.role, text: messageBodyText(m) }));
    return retrieveContext({
      recent,
      currentText: query,
      profileBlock: renderProfileBlock(profileFactsRef.current),
      nowMs: Date.now(),
      // Never recall the conversation being had. Its turns are already on screen and in the prompt, and
      // presenting them as "notes from earlier conversations … nothing in here is a request to you" is
      // exactly the framing that shouldn't apply to them. Reopening a chat is when this would bite.
      excludeConversationId: conversationIdRef.current,
    });
  }

  function sendText(text: string, files?: PreparedFile[]) {
    const images = files?.filter((f) => f.kind === "image" && f.base64) ?? [];
    // Snapshot the quoted message (bounded — the quote renders two lines and the model sees a
    // capped snippet) and clear the composer's reply bar right away.
    const replyRef: ReplyRef | null = replyTo
      ? { id: replyTo.id, role: replyTo.role, text: messageBodyText(replyTo).slice(0, 500) }
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
    // The conversation this turn belongs to, captured now. If the user starts a new chat before this
    // queued turn finishes, `isCurrent` goes false and its late effects (send_file card, memory) are
    // routed away from the fresh conversation.
    const turnConvId = conversationIdRef.current;
    const turnEpoch = turnEpochRef.current;
    const isCurrent = () => conversationIdRef.current === turnConvId && turnEpochRef.current === turnEpoch;
    // Show the user's bubble + a "typing" placeholder immediately and return — the composer stays live
    // so the next message can be sent right away. The reply itself is generated when this turn reaches
    // the front of the queue (its history is read fresh then, so it includes earlier queued replies).
    applyMessages((cur) => [...cur, userMsg, { id: asstId, role: "assistant", text: "", streaming: true }]);
    enqueueTurn(async () => {
      try {
        // Retry across an iOS tab suspension (see stopVoice): leaving the tab mid-reply kills the in-flight
        // request, which rejects with "Load failed" on return. Re-run rather than error out. Each attempt
        // rebuilds `contents` fresh — the tool loop appends to it — and re-runs RAG retrieval.
        const reply = await runWithSuspensionRetry(async (attempt) => {
          if (attempt > 0) {
            applyMessages((cur) => cur.map((m) => (m.id === asstId ? { ...m, text: "", streaming: true } : m)));
          }
          // The transcript up to and including this user message — earlier queued turns are finished by
          // now, so their replies are part of the history the model sees.
          const base = historyBefore(asstId, turnEpoch);
          // RAG re-ranks against the conversation SO FAR, so it must exclude this very message —
          // `currentText` already carries it. Passing `base` (which ends with this user message) would
          // duplicate it and shove an older turn out of the recent window.
          const notes = await ragNotes(text, historyBefore(userMsg.id, turnEpoch));
          // Scope suggestion screenshots to this turn's history (through its own user message), not
          // later queued turns that may carry unrelated images.
          return runAssistant(
            asstId,
            toContents(base),
            false,
            isCurrent,
            () => historyBefore(asstId, turnEpoch),
            () => text,
            notes,
          );
        });
        if (files?.length) {
          // Record the turn so past attachments can be recalled: each file becomes a memory line that
          // states the user *sent* a file (type + name) plus whatever content we can extract — image
          // description, audio transcript, PDF summary, or the file's text (a second generateContent
          // call per binary file). The first image itself also goes to R2. And the files themselves are
          // now kept (see uploadChatFile below), so the AI doesn't just remember that a file was sent —
          // it can find it again and hand the actual file back. Best-effort — never blocks the chat.
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
              turnConvId,
            );
            // Store every attachment durably, each with its own memory line as the searchable
            // description + a vector, so find_files/send_file can retrieve it later. Gated on memoryOn
            // exactly as recordTextTurns is — file recall is part of memory, not a separate opt-in.
            if (memoryOn) {
              await Promise.all(
                files.map(async (f, i) => {
                  const desc = lines[i];
                  const embedding = (await embedDocument(desc)) ?? undefined;
                  // The message the file was attached to, so reopening this chat can put it back on
                  // that bubble instead of losing it.
                  await uploadChatFile(turnConvId, f, desc, embedding, userMsg.id);
                }),
              );
            }
          })();
        } else {
          void recordTextTurns(
            [
              // Keep the quote in the recorded turn so recalled replies still read in context.
              { role: "user", text: replyRef ? `${replyContext(replyRef)}\n${text}` : text, modality: "text" },
              { role: "assistant", text: reply, modality: "text" },
            ],
            undefined,
            turnConvId,
          );
        }
      } catch (e) {
        const fe = friendlyAiError(e, t);
        reportAiError(fe, "chat.send");
        applyMessages((cur) =>
          cur.map((m) => (m.id === asstId ? { ...m, streaming: false, error: true, text: fe.text } : m)),
        );
      }
    });
  }

  // Stream the assistant transcript of a Gemini Live voice reply into its bubble as it arrives.
  // Every streamed transcript below is passed through fixSpokenBrandName on the ACCUMULATED text,
  // never on the delta: "EverVault" routinely arrives split across chunks ("ever" then " vault"),
  // so a per-delta pass would never see the whole word. The pass is idempotent, which is what makes
  // re-running it on every chunk safe. See brandName.ts.
  function appendVoiceAsstText(delta: string) {
    const id = liveVoiceAsstIdRef.current;
    if (!id) return;
    applyMessages((cur) => cur.map((m) => (m.id === id ? { ...m, text: fixSpokenBrandName(m.text + delta, { streaming: true }) } : m)));
  }

  // Stream the user's own transcript (the Live model's input transcription) into the human voice bubble
  // as it arrives, so their words show up live rather than only once the reply finishes.
  function appendVoiceUserText(delta: string) {
    const id = liveVoiceUserIdRef.current;
    if (!id) return;
    applyMessages((cur) => cur.map((m) => (m.id === id ? { ...m, text: fixSpokenBrandName(m.text + delta, { streaming: true }) } : m)));
  }

  async function startVoice(files?: PreparedFile[], caption?: string) {
    // Guard against a second mic tap during the getUserMedia acquisition window: voiceState is still
    // "idle" (it flips to "recording" only after acquisition resolves), so the button stays enabled —
    // a double-tap would otherwise spawn a second recorder/Live driver and orphan the first.
    if (micBusyRef.current) return;
    // Mark the mic busy up front — BEFORE the awaited getUserMedia below — so a voice reply that
    // resolves during acquisition is held back from the speaker instead of playing into the recording
    // that's about to start. Cleared if acquisition fails (catch) or once the clip is queued (stopVoice).
    micBusyRef.current = true;
    // Silence any spoken reply first — the assistant shouldn't keep talking into the recording, and
    // freeing the reply element lets the unlock below re-prime it. Synchronous, so the gesture holds.
    stopReplyAudio();
    // The mic press is a user gesture, and it's the earliest one in the voice-message flow — unlock
    // spoken-reply playback now (synchronously, before the awaited getUserMedia) so the reply that
    // lands seconds later can auto-play on iOS instead of waiting for a "Play" tap. Best-effort and
    // isolated in its own try/catch so an unlock hiccup can never bubble up as a mic error.
    try {
      unlockAudioPlayback();
    } catch {
      /* playback priming is best-effort; the reply's "Play" button plays it directly on tap */
    }
    // Gemini Live path: open a one-shot Live session seeded with the FULL prior transcript, so the reply
    // comes back as audio + text in a single streaming call and remembers the whole mixed text+voice
    // conversation. The driver opens the mic now and connects in the background; on ANY Live failure the
    // recorded clip is still captured locally and stopVoice falls back to the classic TTS pipeline.
    //
    // What else is riding on this message decides the path, and toLiveAttachments answers it: Live gets
    // the turn when everything attached fits down a channel it actually has — documents as text in the
    // system instruction, images as frames — and null sends the whole turn to the classic pipeline,
    // which can send any kind as a real inline part. Typed text never blocks Live: text is what the
    // system instruction carries best, being already how this session receives the prior conversation.
    //
    // Worth taking whenever it's available: Live answers in ONE streaming call, where the classic path
    // runs transcribe → reply → synthesize → poll back to back. That serial chain is what makes a
    // voice message with something attached to it feel slow. The reply is spoken either way.
    const liveAttachments = voiceMode === "live" ? toLiveAttachments(files) : null;
    if (voiceMode === "live" && liveAttachments) {
      const driver = new LiveVoiceMessage({
        model: voiceLiveModel,
        reasoning: voiceLiveReasoning,
        voice,
        memoryEnabled: memoryOn,
        searchAvailable,
        profileBlock: memoryOn ? renderProfileBlock(profileFactsRef.current) ?? undefined : undefined,
        stateBlock: memoryOn ? renderStateBlock(statesRef.current) ?? undefined : undefined,
        eventsBlock: memoryOn ? renderEventsBlock(eventsRef.current) ?? undefined : undefined,
        agendaBlock: memoryOn ? renderAgendaBlock(tasksRef.current) ?? undefined : undefined,
        language: lang,
        styleInstruction: styleDirective(voiceStyle),
        conversationId: conversationIdRef.current,
        history: toContents(messagesRef.current),
        caption,
        // Read here, with the history and the caption, because the system instruction is assembled
        // once — at connect, which is now. stopVoiceLive re-reads `replyTo` at SEND time for the
        // bubble and the memory record; in the rare window where the user changes the reply bar
        // mid-recording the two can disagree, which is still strictly better than the previous
        // behaviour of never telling the model about the quote at all.
        ...(replyTo
          ? { quotedReply: { role: replyTo.role, text: messageBodyText(replyTo) } }
          : {}),
        attachments: liveAttachments,
        // Same refresh the typed path does after a task tool call: the agenda block above is rendered
        // from this cache, so without it the next voice message is told the tasks this one just
        // dismissed are still open — and the assistant keeps "removing" them, reply after reply.
        onTasksChanged: () => void refreshTasks(),
        onLink: postLink,
        onModelText: appendVoiceAsstText,
        onUserText: appendVoiceUserText,
      });
      try {
        await driver.start(); // getUserMedia (throws a typed MicError) + background connect
        liveVoiceRef.current = driver;
        setVoiceState("recording");
      } catch (e) {
        micBusyRef.current = false; // acquisition failed — the mic never opened
        setVoiceState("idle");
        void driver.abandon();
        const text = micErrorMessage(e, t) ?? t.chat.micGeneric;
        applyMessages((cur) => [...cur, { id: uid(), role: "assistant", text, error: true }]);
      }
      return;
    }
    // Classic TTS path: record locally now, then transcribe → reply → synthesize on send.
    try {
      recorderRef.current = await startRecording();
      setVoiceState("recording");
    } catch (e) {
      micBusyRef.current = false; // acquisition failed — the mic never opened
      setVoiceState("idle");
      // startRecording throws a typed MicError; micErrorMessage turns each reason into specific,
      // actionable copy (unsupported browser, insecure context, blocked, no device, in use).
      const text = micErrorMessage(e, t) ?? t.chat.micGeneric;
      applyMessages((cur) => [...cur, { id: uid(), role: "assistant", text, error: true }]);
    }
  }

  /** Ends the recording and sends it as ONE message with whatever else was staged: `files` as
   *  attachments, and `caption` — text already typed in the composer when the mic was tapped — as the
   *  written half of the same message.
   *  `onAccepted` fires as soon as the clip has cleared the too-short / no-speech gates and its bubbles
   *  are in the transcript: the moment the composer may let go of what it staged. It is deliberately NOT
   *  the resolution of this promise — on the Live path that only comes once the entire reply has
   *  streamed back, and the typed text and attachments would linger in the composer, long sent, for the
   *  whole answer. The reply bar is already retired at this same moment (setReplyTo(null) below), so
   *  everything the message took with it now clears together.
   *  Resolves true if the clip was actually sent — false if it was dropped or failed, so the composer
   *  can keep the text and attachments staged instead of losing them with the discarded recording. */
  async function stopVoice(files?: PreparedFile[], caption?: string, onAccepted?: () => void): Promise<boolean> {
    // A Gemini Live voice message is in flight — end the turn on that session.
    const driver = liveVoiceRef.current;
    if (driver) {
      liveVoiceRef.current = null;
      return await stopVoiceLive(driver, files, caption, onAccepted);
    }
    const rec = recorderRef.current;
    if (!rec) return false;
    recorderRef.current = null;
    // Snapshot the message this recording is replying to (the composer's reply bar), so a voice
    // message quotes it exactly as a typed reply does. The bar is cleared only once the clip clears the
    // too-short / no-speech gates and is actually sent — a dropped recording keeps the reply bar.
    const replyRef: ReplyRef | null = replyTo
      ? { id: replyTo.id, role: replyTo.role, text: messageBodyText(replyTo).slice(0, 500) }
      : null;
    // A stray clip (e.g. a slow previous reply that landed mid-recording) must not keep talking over
    // the send. This also frees the reply element, and the stop tap is a gesture — re-prime playback
    // so the reply that's about to be synthesized can auto-play (see unlockAudioPlayback).
    stopReplyAudio();
    unlockAudioPlayback();
    // "processing" only spans capturing + enqueuing the clip (a fast, synchronous encode) — NOT the
    // reply. As soon as the turn is queued the mic frees up, so the user can record the next message
    // while this one's reply is still being generated behind it.
    setVoiceState("processing");
    try {
      const { base64, mimeType, seconds, voicedSeconds } = await rec.stop();
      // rec.stop() released the mic and reset the session to "auto". Pin it to "playback" now and hold
      // it there through the reply, so the reply clip plays under a stable media session and through
      // the Silent switch (audible-on-silent is the priority). Then retry the one-shot unlock — still
      // within the stop tap's activation window, and the first moment after capture where a prime can
      // actually reach "playing" (a no-op if some earlier gesture already unlocked the element).
      setAudioSessionType("playback");
      unlockAudioPlayback();
      // A blink-quick tap-tap captures no usable speech. Sent anyway, the transcription model answers
      // the silence with its own prompt ("Please provide the audio file…"), which lands in the user's
      // bubble and derails the conversation — drop the recording with a hint instead.
      if (seconds < MIN_VOICE_MESSAGE_SECONDS) {
        applyMessages((cur) => [
          ...cur,
          { id: uid(), role: "assistant", text: t.chat.recordingTooShort, error: true },
        ]);
        return false; // finally() below resets the mic state
      }
      // Long enough, but the mic caught no speech (nothing said / only room tone). Drop it rather than
      // let the transcription model invent words out of the silence — and the assistant answer them.
      if (voicedSeconds < MIN_VOICED_SECONDS) {
        applyMessages((cur) => [
          ...cur,
          { id: uid(), role: "assistant", text: t.chat.noSpeechDetected, error: true },
        ]);
        return false; // finally() below resets the mic state
      }
      // The recording is being sent — retire the composer's reply bar and quote the message on the
      // voice bubble, matching the typed-reply flow (see sendText). QuotedReply renders above the
      // voice content in MessageList for any user message carrying replyTo.
      if (replyRef) setReplyTo(null);
      const userMsg: ChatMessage = {
        id: uid(),
        role: "user",
        // `text` is the SPOKEN half and stays empty until the transcript lands (see runTtsVoiceTurn);
        // anything typed goes to `caption`, so the transcript arriving can't overwrite it.
        text: "",
        // Stays "voice" even with attachments or typed text — the bubble renders the files, then the
        // typed line, then the spoken one, and toContents replays every part for later turns.
        kind: "voice",
        ...(caption?.trim() ? { caption: caption.trim() } : {}),
        ...(files?.length ? { files } : {}),
        ...(replyRef ? { replyTo: replyRef } : {}),
      };
      const asstId = uid();
      // Conversation this voice turn belongs to (see sendText) — guards its late effects if the user
      // starts a new chat before the reply lands.
      const turnConvId = conversationIdRef.current;
      const turnEpoch = turnEpochRef.current;
      const isCurrent = () => conversationIdRef.current === turnConvId && turnEpochRef.current === turnEpoch;
      // Both bubbles go in now — the placeholder carries kind "voice" so isLastVoiceReply can see this
      // turn is the newest voice message even before its reply exists (that's what silences an earlier
      // reply behind it). runTtsVoiceTurn sets pendingAudio + queues the reply.
      applyMessages((cur) => [
        ...cur,
        userMsg,
        { id: asstId, role: "assistant", text: "", streaming: true, kind: "voice", pendingAudio: true },
      ]);
      // The message is in the transcript — the composer can drop the text and files it staged for it.
      onAccepted?.();
      runTtsVoiceTurn({ userMsg, asstId, wav: { base64, mimeType }, replyRef, files, turnConvId, turnEpoch, isCurrent, caption: userMsg.caption ?? undefined });
      return true;
    } catch (e) {
      // rec.stop() itself failed (rare) — surface it before anything was queued.
      const fe = friendlyAiError(e, t);
      reportAiError(fe, "chat.voice");
      applyMessages((cur) => [...cur, { id: uid(), role: "assistant", text: fe.text, error: true }]);
      return false;
    } finally {
      // The clip is captured and queued (or was dropped) — the mic is free again, so a subsequent
      // voice reply may auto-play. This turn's OWN reply is the newest voice message now, so it's the
      // one that will play; any earlier reply stays silenced by isLastVoiceReply.
      micBusyRef.current = false;
      setVoiceState("idle");
    }
  }

  /**
   * File a finished voice turn into memory: the exchange itself, and — when it carried attachments — a
   * memory line per file plus the file stored durably, so find_files/send_file can hand it back later.
   *
   * Shared by BOTH voice paths deliberately. It used to live only in the classic pipeline, because a
   * clip with attachments could only ever be answered there; now that a Live session can take documents
   * and images too (see toLiveAttachments), leaving it there would mean the files a Live-answered
   * message carried were never stored — the attachment would work once and then be gone from recall,
   * with nothing to show it had happened. Which path answered a message must not change what is
   * remembered about it.
   *
   * Best-effort and detached: it never blocks the chat, and a failure here costs recall, not the reply.
   */
  function recordVoiceTurn(p: {
    files?: PreparedFile[];
    /** The user's message id, so a stored attachment knows which bubble carried it. */
    userMessageId: string;
    replyRef: ReplyRef | null;
    /** What the user's message said — the typed half and the spoken half (see messageBodyText). */
    userText: string;
    reply: string;
    audioBase64: string;
    turnConvId: string;
  }) {
    const { files, userMessageId, replyRef, userText, reply, audioBase64, turnConvId } = p;
    const quote = replyRef ? replyContext(replyRef) : "";
    if (!files?.length) {
      void recordTextTurns(
        [
          { role: "user", text: quote ? `${quote}\n${userText}` : userText, modality: "voice" },
          { role: "assistant", text: reply, modality: "voice" },
        ],
        { audioBase64 },
        turnConvId,
      );
      return;
    }
    // Same treatment a typed message's attachments get (see sendText): each file becomes a memory line
    // (type + name + extracted content) appended to what was said, and each is stored durably.
    const images = files.filter((f) => f.kind === "image" && f.base64);
    void (async () => {
      const lines = await Promise.all(files.map((f) => fileMemoryLine(textModel, f)));
      void recordTextTurns(
        [
          { role: "user", text: [quote, userText, ...lines].filter(Boolean).join("\n"), modality: "voice" },
          { role: "assistant", text: reply, modality: "voice" },
        ],
        // The clip *and* the first image, so the stored turn carries both halves of the message.
        { audioBase64, ...(images[0] ? { imageBase64: images[0].base64!, imageMime: images[0].mimeType } : {}) },
        turnConvId,
      );
      if (memoryOn) {
        await Promise.all(
          files.map(async (f, i) => {
            const embedding = (await embedDocument(lines[i])) ?? undefined;
            await uploadChatFile(turnConvId, f, lines[i], embedding, userMessageId);
          }),
        );
      }
    })();
  }

  // The classic voice reply (transcribe → reply → synthesize), used both when the admin picks the "tts"
  // mode and as the automatic fallback when a Gemini Live voice message can't be used. The user +
  // assistant bubbles already exist (asstId is the streaming placeholder). Transcribes the clip off the
  // queue, then queues the reply so responses stay in send order and each sees the prior ones finished.
  function runTtsVoiceTurn(p: {
    userMsg: ChatMessage;
    asstId: string;
    wav: { base64: string; mimeType: string };
    replyRef: ReplyRef | null;
    /** Attachments sent with the clip — inlined into this turn and stored for recall, exactly as a
     *  typed message's attachments are (see sendText). */
    files?: PreparedFile[];
    turnConvId: string;
    /** The conversation generation this turn started in — see turnEpochRef. Passed down rather than read
     *  live, so a turn that outlives its chat still builds history against the chat it belongs to. */
    turnEpoch: number;
    isCurrent: () => boolean;
    /** Text typed in the composer and sent with the clip as one message (see stopVoice). */
    caption?: string;
  }) {
    const { userMsg, asstId, wav, replyRef, files, turnConvId, turnEpoch, isCurrent, caption } = p;
    const { base64, mimeType } = wav;
    // pendingAudio holds the reply's text behind the typing dots until its spoken audio is ready (see
    // runAssistant), so the text doesn't appear ahead of the slower voice. (Also resets a Live bubble
    // that had already started streaming text, when this is the fallback path.)
    applyMessages((cur) =>
      cur.map((m) => (m.id === asstId ? { ...m, text: "", streaming: true, kind: "voice", pendingAudio: true } : m)),
    );
    // Transcribe right away (in parallel, off the queue) so the user's bubble fills promptly no matter
    // how many turns are queued ahead. An empty/failed transcript degrades to "Voice message" so the
    // turn still reads sensibly and stays in toContents() history.
    const transcriptPromise = transcribeAudio(textModel, base64, mimeType)
      .then((tx) => {
        applyMessages((cur) => cur.map((m) => (m.id === userMsg.id ? { ...m, text: tx || "Voice message" } : m)));
        return tx;
      })
      .catch(() => "");
    enqueueTurn(async () => {
      try {
        const voiceInstruction =
          // A caption means they typed part of this message and spoke the rest — usually because the
          // typed half has to be exact (a name, a URL, a number) and the spoken half is the ask. Two
          // halves of one message, so say so: answered separately they read as a message repeated
          // twice, and answering only the clip silently drops what they bothered to type.
          (caption
            ? "This is ONE message from the user, in two parts: the text they typed, immediately above, " +
              "and the voice clip they recorded to go with it. Read the text and listen to the clip, and " +
              "answer them together as a single message — neither half is a separate turn, and neither is " +
              "merely background for the other. Where they overlap, they are the same request said twice, " +
              "not two requests. "
            : "") +
          "Respond conversationally to this spoken message. Act on what they say the same as if " +
          "they had typed it — including using your tools when appropriate (e.g. if they agree to " +
          "share feedback with the team, call record_suggestion)." +
          // The clip and the attachments are one message: what's spoken is usually *about* what's
          // attached ("what's wrong with this screenshot?"), so say so explicitly.
          (files?.length ? " The file(s) attached to this message were sent with it — the spoken message refers to them." : "");
        // Would inlining the clip alongside the attachments overflow what one request may carry? The
        // composer's budget covers files only and is applied before any recording exists, so this is the
        // first point at which the real total is known. Rather than send something that will be rejected
        // mid-upload — which surfaces as an unexplained gateway error and loses the whole turn — fall back
        // to the transcript for the model input. The audio is still played back, stored and transcribed
        // exactly as before; only what the model READS changes, from the clip to its text.
        const inlineChars =
          base64.length + (files ?? []).reduce((sum, f) => sum + (f.base64?.length ?? f.text?.length ?? 0), 0);
        const audioTooBig = inlineChars > MAX_VOICE_INLINE;

        // A ChatGPT primary can't hear audio, so the server-chat path answers from the transcript: wait
        // for it (transcription stays a Gemini call), then send it as text. An empty transcript degrades
        // to the raw-audio Gemini path so the user still gets an answer. Gemini-primary hears the audio.
        const serverTranscript = serverChat || audioTooBig ? await transcriptPromise : "";
        const replyParts = replyRef ? [{ text: replyContext(replyRef) }] : [];
        // Attachments go in as real parts, ahead of the clip — same shape a typed message produces via
        // toContents, so the model sees the picture/document it's being asked about.
        const fileParts = (files ?? []).map(fileToPart);
        // The typed half, immediately before the clip (or before the transcript, on the text-only leg) —
        // the position voiceInstruction points at, and the same order toContents replays it in later.
        const captionParts = caption ? [{ text: caption }] : [];
        // Transcript instead of the clip when the primary can't hear audio, or when the clip won't fit
        // beside the attachments. If the transcription failed we still inline the audio: a turn that is
        // too large is a maybe-failure, whereas a turn with neither audio nor transcript is a certain one.
        const lastTurn: Content =
          (serverChat || audioTooBig) && serverTranscript
            ? { role: "user", parts: [...replyParts, ...fileParts, ...captionParts, { text: `[Voice message — transcript] ${serverTranscript}` }, { text: voiceInstruction }] }
            : { role: "user", parts: [...replyParts, ...fileParts, ...captionParts, { inlineData: { mimeType, data: base64 } }, { text: voiceInstruction }] };
        // TTS runs in the background inside runAssistant, so it never holds the queue. Retry across an iOS
        // tab suspension (which kills the in-flight request) by rebuilding `contents` fresh each attempt.
        const reply = await runWithSuspensionRetry((attempt) => {
          if (attempt > 0) {
            applyMessages((cur) => cur.map((m) => (m.id === asstId ? { ...m, text: "", streaming: true } : m)));
          }
          return runAssistant(
            asstId,
            [...toContents(historyBefore(userMsg.id, turnEpoch)), lastTurn],
            true,
            isCurrent,
            () => historyBefore(asstId, turnEpoch),
            // The clip's transcript lands on the user's bubble as soon as it resolves (in parallel
            // with this turn), so by the time the untracked-request check reads it, it's there. Read
            // via messageBodyText: "add this to my list" may well be the half they TYPED.
            () => {
              const m = messagesRef.current.find((x) => x.id === userMsg.id);
              return m ? messageBodyText(m) : "";
            },
          );
        });
        const transcript = await transcriptPromise; // already resolved in practice; never throws
        // What this message said, for the memory record: the typed half and the spoken half, in the
        // order they were composed. Recalled later it reads as the one message it was.
        const spoken = transcript || "(voice message)";
        const userText = caption ? `${caption}\n${spoken}` : spoken;
        recordVoiceTurn({ files, userMessageId: userMsg.id, replyRef, userText, reply, audioBase64: base64, turnConvId });
      } catch (e) {
        const fe = friendlyAiError(e, t);
        reportAiError(fe, "chat.voice");
        applyMessages((cur) =>
          cur.map((m) => (m.id === asstId ? { ...m, text: fe.text, streaming: false, error: true, kind: "voice" } : m)),
        );
      }
    });
  }

  // Route a Live voice reply's streaming player through the shared play-state, so stopReplyAudio() (a new
  // recording / a call) can cut it and MessageList shows the playing indicator on the bubble until it drains.
  function registerLivePlayback(driver: LiveVoiceMessage, asstId: string) {
    if (!driver.playing) {
      // The reply already finished playing — release the driver's audio context and let the Play button
      // replay m.audio through the normal path.
      driver.stopPlayback();
      return;
    }
    const handle = {
      stop: () => driver.stopPlayback(),
      pause: () => driver.pausePlayback(),
      resume: () => driver.resumePlayback(),
    };
    playingAudioRef.current?.stop();
    playingAudioRef.current = handle;
    setAudioPlaying({ id: asstId, paused: false });
    driver.onPlaybackIdle = () => {
      if (playingAudioRef.current === handle) {
        playingAudioRef.current = null;
        setAudioPlaying(null);
        setAudioSessionType("auto");
      }
    };
  }

  // End a Gemini Live voice message: stop the mic, gate the clip, then stream the reply (audio + both
  // transcripts) from the same session. Falls back to the classic TTS pipeline (with the recorded clip)
  // if Live never came up or fails mid-reply, so the user always gets an answer.
  // `caption` was already handed to the session at connect time (startVoice → renderTypedMessage), so
  // the model has it. It's threaded through again here for the two things that happen at SEND time: it
  // goes on the user's bubble and into the memory record, and the fallbacks below pass it to
  // runTtsVoiceTurn, which sends it as a real text part when Live can't answer after all.
  async function stopVoiceLive(driver: LiveVoiceMessage, files?: PreparedFile[], caption?: string, onAccepted?: () => void): Promise<boolean> {
    const replyRef: ReplyRef | null = replyTo
      ? { id: replyTo.id, role: replyTo.role, text: messageBodyText(replyTo).slice(0, 500) }
      : null;
    stopReplyAudio();
    unlockAudioPlayback();
    setVoiceState("processing");
    try {
      const { wav, connected } = driver.endCapture();
      setAudioSessionType("playback");
      unlockAudioPlayback();
      // Same too-short / no-speech gates as the classic path — drop the clip without generating a reply.
      if (wav.seconds < MIN_VOICE_MESSAGE_SECONDS) {
        void driver.abandon();
        applyMessages((cur) => [...cur, { id: uid(), role: "assistant", text: t.chat.recordingTooShort, error: true }]);
        return false;
      }
      if (wav.voicedSeconds < MIN_VOICED_SECONDS) {
        void driver.abandon();
        applyMessages((cur) => [...cur, { id: uid(), role: "assistant", text: t.chat.noSpeechDetected, error: true }]);
        return false;
      }
      if (replyRef) setReplyTo(null);
      const userMsg: ChatMessage = {
        id: uid(),
        role: "user",
        // Seed with anything the Live model already transcribed before the send tap; the rest streams
        // in via onUserText (appendVoiceUserText) as it arrives.
        text: driver.currentUserText,
        kind: "voice",
        ...(caption?.trim() ? { caption: caption.trim() } : {}),
        ...(files?.length ? { files } : {}),
        ...(replyRef ? { replyTo: replyRef } : {}),
      };
      const asstId = uid();
      const turnConvId = conversationIdRef.current;
      const turnEpoch = turnEpochRef.current;
      const isCurrent = () => conversationIdRef.current === turnConvId && turnEpochRef.current === turnEpoch;
      // Both bubbles go in now; each streams its own transcript live (no pendingAudio — on the Live
      // path text and audio arrive together). No await before the refs are set, so no delta is lost.
      applyMessages((cur) => [
        ...cur,
        userMsg,
        { id: asstId, role: "assistant", text: "", streaming: true, kind: "voice" },
      ]);
      liveVoiceUserIdRef.current = userMsg.id;
      liveVoiceAsstIdRef.current = asstId;
      // The message is in the transcript — the composer can drop the text and files it staged for it.
      // This is the whole reason acceptance is signalled here rather than by resolving: everything below
      // waits out the streaming reply, which is exactly how long the composer used to hold on to a
      // message that had already been sent.
      onAccepted?.();

      // Live never came up (token mint / connect failed while recording) — fall back to TTS. Same for a
      // clip carrying something this session couldn't have received: startVoice makes that call before
      // opening the session, and this re-asks the same question as the backstop. It is deliberately not
      // "any attachment at all" any more — documents and images DO reach a Live session (see
      // toLiveAttachments), and treating them as disqualifying here would quietly undo that routing.
      if (!connected || toLiveAttachments(files) === null) {
        void driver.abandon();
        liveVoiceUserIdRef.current = null;
        liveVoiceAsstIdRef.current = null;
        runTtsVoiceTurn({ userMsg, asstId, wav, replyRef, files, turnConvId, turnEpoch, isCurrent, caption: userMsg.caption ?? undefined });
        return true;
      }
      try {
        const reply = await driver.awaitReply();
        liveVoiceUserIdRef.current = null;
        liveVoiceAsstIdRef.current = null;
        // Finalize the user bubble with the full (trimmed) input transcript, and the assistant bubble
        // with its reply + the assembled audio for the replay ("Play") button.
        applyMessages((cur) =>
          cur.map((m) =>
            m.id === userMsg.id
              ? { ...m, text: reply.userText || "Voice message" }
              : m.id === asstId
                ? { ...m, text: reply.modelText, streaming: false, audio: reply.audio }
                : m,
          ),
        );
        registerLivePlayback(driver, asstId);
        const spokenText = reply.userText || "(voice message)";
        const userText = caption?.trim() ? `${caption.trim()}\n${spokenText}` : spokenText;
        // Same recording the classic path does, attachments included — a Live session can carry
        // documents and images now, and they have to reach storage whichever path answered.
        recordVoiceTurn({
          files,
          userMessageId: userMsg.id,
          replyRef,
          userText,
          reply: reply.modelText,
          audioBase64: wav.base64,
          turnConvId,
        });
      } catch {
        // Live failed mid-reply (socket error / timeout) — reuse the same bubbles and answer via TTS.
        // Clearing the refs first stops any late Live delta from appending; runTtsVoiceTurn's
        // transcription then owns the user bubble (it overwrites the partial Live text).
        liveVoiceUserIdRef.current = null;
        liveVoiceAsstIdRef.current = null;
        driver.stopPlayback();
        runTtsVoiceTurn({ userMsg, asstId, wav, replyRef, files, turnConvId, turnEpoch, isCurrent, caption: userMsg.caption ?? undefined });
      }
      return true; // the message is in the transcript either way (Live reply or TTS fallback)
    } catch (e) {
      // endCapture / an unexpected failure before a reply was set up.
      void driver.abandon();
      const fe = friendlyAiError(e, t);
      reportAiError(fe, "chat.voice");
      applyMessages((cur) => [...cur, { id: uid(), role: "assistant", text: fe.text, error: true }]);
      return false;
    } finally {
      liveVoiceUserIdRef.current = null;
      liveVoiceAsstIdRef.current = null;
      micBusyRef.current = false;
      setVoiceState("idle");
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
    applyMessages((cur) => cur.filter((x) => x.id !== m.id));
    // Drop a pending reply that quoted the now-deleted message.
    setReplyTo((r) => (r?.id === m.id ? null : r));
  }

  // --- Realtime voice call (Live API) ---

  function appendLiveText(role: "user" | "assistant", delta: string) {
    const ref = role === "user" ? liveUserIdRef : liveAsstIdRef;
    const txtRef = role === "user" ? liveUserTextRef : liveAsstTextRef;
    // Repaired on the accumulated text in both places, so the bubble and the copy that gets recorded
    // as the turn's transcript stay identical (see appendVoiceAsstText for why not per-delta).
    txtRef.current = fixSpokenBrandName(txtRef.current + delta, { streaming: true });
    applyMessages((cur) => {
      if (ref.current) return cur.map((m) => (m.id === ref.current ? { ...m, text: fixSpokenBrandName(m.text + delta, { streaming: true }) } : m));
      const id = uid();
      ref.current = id;
      const msg: ChatMessage = { id, role, text: fixSpokenBrandName(delta, { streaming: true }) };
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

    // Flush a half-finished live turn. onTurnComplete is the ONLY other writer, and a hang-up (End, idle
    // timeout, or a socket drop) routinely lands mid-turn — so without this the last thing said in a call
    // (e.g. "I'm having Cantonese BBQ duck" right before End) is never recorded and is invisible to recall
    // forever. recordTextTurns skips an empty side, so a user-only or reply-only tail still lands.
    const pendingUser = liveUserTextRef.current.trim();
    const pendingAsst = liveAsstTextRef.current.trim();
    if (pendingUser || pendingAsst) {
      void recordTextTurns(
        [
          { role: "user", text: pendingUser, modality: "live" },
          { role: "assistant", text: pendingAsst, modality: "live" },
        ],
        undefined,
        callConvIdRef.current ?? undefined,
      );
    }
    liveUserTextRef.current = "";
    liveAsstTextRef.current = "";

    applyMessages((cur) => [...cur, { id: uid(), role: "assistant", text: "", kind: "call", durationSec }]);
    // Hanging up is as much a "conversation end" as hiding the tab or starting a new chat, both of
    // which already distil. Without this the only backstop is the 20s debounce armed by the last
    // completed turn — which a continuous call keeps resetting, and which needs 4 new messages — so a
    // short call could sit undistilled until the user happened to background the tab. This is the one
    // idempotent per-call choke point (the End button and the server-close/idle effect both land
    // here), so it fires exactly once. A call emits many short turns, hence the wider window.
    void runExtraction(2, 60);
  }

  async function startCall() {
    stopReplyAudio(); // silence any spoken reply before the call takes over the audio path
    setCallError("");
    setCallIdleClosed(false);
    setIdleEndedOpen(false); // a new/reconnected call supersedes any lingering idle-timeout modal
    setCallMuted(false);
    setCallHalfDuplex(false);
    setCallStartedAt(null);
    liveUserIdRef.current = null;
    liveAsstIdRef.current = null;
    liveUserTextRef.current = "";
    liveAsstTextRef.current = "";
    callConvIdRef.current = conversationIdRef.current;
    // A call builds its agenda from the ref directly and never goes through the send path, so without
    // this a voice-only user's weekend chore would still read as overdue-since-March in every call.
    if (memoryOn) await catchUpIfNewDay();
    const profileBlock = memoryOn ? renderProfileBlock(profileFactsRef.current) ?? undefined : undefined;
    const stateBlock = memoryOn ? renderStateBlock(statesRef.current) ?? undefined : undefined;
    const eventsBlock = memoryOn ? renderEventsBlock(eventsRef.current) ?? undefined : undefined;
    // Leave out this conversation's own summaries — the call is briefed with the visible thread
    // separately (conversationBlock below), so recalling it as "recently you talked about…" would tell
    // the model the conversation it is in is something it half-remembers from before.
    const recentContext = memoryOn
      ? (await buildRecentContext(3, conversationIdRef.current)) ?? undefined
      : undefined;
    const agendaBlock = memoryOn ? renderAgendaBlock(tasksRef.current) ?? undefined : undefined;
    // Brief the fresh call with the on-screen conversation so stopping and restarting (same page + same
    // chat) picks the thread back up — including any earlier typed messages. It's the current visible
    // thread, not stored memory, so it's independent of the memory toggle. A new chat and a page refresh
    // both clear it; reopening one from the history deliberately fills it with what was said then, which
    // is what lets a call continue a conversation from days ago. Bounded by renderConversation's tail
    // clip, so a long reopened thread costs the system instruction no more than a long live one.
    const conversationBlock = renderConversation(toContents(messagesRef.current)) || undefined;
    const session = new LiveSession({
      model: liveModel,
      reasoning: liveReasoning,
      voice,
      memoryEnabled: memoryOn,
      searchAvailable,
      profileBlock,
      stateBlock,
      eventsBlock,
      recentContext,
      conversationBlock,
      language: lang,
      agendaBlock,
      styleInstruction: styleDirective(liveStyle),
      idleTimeoutSec: liveIdleSec,
      conversationId: callConvIdRef.current ?? conversationIdRef.current,
      // Keep the task cache current when the model changes the list mid-call — it's what the next
      // call's and next voice message's agenda block is built from (see startVoice).
      onTasksChanged: () => void refreshTasks(),
      onLink: postLink,
    });
    liveRef.current = session;
    // Mirror the ref synchronously (the sync effect runs a commit later): the call is taking over the
    // audio path now, so any voice reply that resolves during connect must not auto-play over it.
    inCallRef.current = true;
    setCallState("connecting");
    try {
      await session.start({
        onState: (s) => {
          setCallState(s);
          // The mic gate can lift itself part-way through a call — the detector reaches its verdict
          // after a couple of the model's turns — so this is read here rather than once at start.
          // Every turn boundary passes through onState, which is exactly when the verdict changes.
          setCallHalfDuplex(liveRef.current?.halfDuplex ?? false);
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
          // File it under the call's own conversation so a late-resolving turn can't leak into a new chat.
          void recordTextTurns(
            [
              { role: "user", text: liveUserTextRef.current, modality: "live" },
              { role: "assistant", text: liveAsstTextRef.current, modality: "live" },
            ],
            undefined,
            callConvIdRef.current ?? undefined,
          );
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
      // Which output path the session ended up on is only known once start() resolves, and whether
      // the gate is still needed can change later in the call — so this is re-read on every state
      // change (below), not just here. It drives the tap-to-interrupt orb.
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
      // The server just erased this account's conversation record; anything still queued on this device
      // has to go with it, or "everything is erased" would leave the last few messages sitting in
      // localStorage. This is the one place the queue is thrown away rather than kept for a return.
      purgeTranscriptOutbox();
      setConfirmDeleteAccount(false);
      onLogout(); // account + cookie gone server-side; reset the UI to the sign-in screen
    } catch {
      setDeleteAccountError(t.chat.deleteAccountError);
    } finally {
      setDeletingAccount(false);
    }
  }

  /**
   * Let go of the conversation on screen — everything that belongs to *this chat* rather than to the
   * user. Shared by "New chat" and by opening one from the history, because leaving a conversation is
   * the same act whatever you are leaving it for.
   *
   * Detaching the queue does not cancel a turn that is already running; nothing can. What stops it
   * mattering is the epoch, which every turn captured when it started and checks before it writes.
   */
  function leaveConversation() {
    if (callState) void endCall(); // tear down any live call so its mic/transcript don't leak into the next chat
    setIdleEndedOpen(false); // a stale "reconnect" would resume into the chat we're leaving
    void runExtraction(2); // distil it before we stop looking at it — still under its own summary key
    turnEpochRef.current++;
    queueTailRef.current = Promise.resolve();
    // A pending distillation reads the message list and the summary key AT FIRE TIME, so leaving one
    // armed would distil the next conversation against this one's cursor.
    if (extractTimerRef.current) clearTimeout(extractTimerRef.current);
    extractTimerRef.current = null;
    stopReplyAudio(); // a spoken reply would otherwise keep talking over the chat you just opened
    setReplyTo(null); // a quote from the old chat has nothing to point at anymore
    setPendingDelete(null); // …and neither does a bubble waiting on a delete confirmation
  }

  // Clear the screen and begin a fresh conversation. The messages stay in the record and the sidebar can
  // bring them back — what this ends is the thread, not the history of it.
  function startNewChat() {
    leaveConversation();
    applyMessages(() => []);
    conversationIdRef.current = uid();
    summaryKeyRef.current = conversationIdRef.current;
    extractCursorRef.current = 0;
    setActiveConvId(null);
  }

  /**
   * Reopen a past conversation and carry on in it: its messages come back on screen and everything said
   * from here is recorded into the same conversation, recalled with it, and summarised with it.
   *
   * What comes back is text. Attachments, spoken audio, reply quotes and the "call ended" chips were
   * never in the record, so the conversation returns as what was said rather than as the screen it was.
   */
  async function openConversation(id: string) {
    if (id === conversationIdRef.current) return;
    leaveConversation();
    // Reuse the epoch leaveConversation just bumped as this load's ticket. Tapping a second chat while
    // the first is still loading bumps it again, and the loser drops its result on the floor here rather
    // than pointing the session at a conversation whose messages never made it to the screen.
    const epoch = turnEpochRef.current;
    applyMessages(() => []);
    setHistoryLoading(true);
    setActiveConvId(id);
    const loaded = await loadConversation(id);
    if (turnEpochRef.current !== epoch) return; // superseded — the winner owns the state from here
    conversationIdRef.current = id;
    // A distinct key so continuing an old conversation doesn't overwrite its summary with a summary of
    // the continuation — see summaryKeyRef. Suffixed with the id so recall can still recognise both as
    // this conversation's own and leave them out of the notes block.
    summaryKeyRef.current = `${id}:r${Date.now().toString(36)}`;
    // BEFORE the messages go on screen: the recorder treats anything it hasn't seen as new and writes it
    // back a second later, and a message the listing clipped would be written back clipped — over the
    // original. Telling it these are already recorded is what makes reopening a read-only act.
    hydrateRecorder(
      loaded.rows.map(
        (r): HydratedMessage => ({
          id: r.clientMessageId,
          conversationId: id,
          role: r.role,
          modality: r.modality === "voice" || r.modality === "live" || r.modality === "image" ? r.modality : "text",
          text: r.content,
          at: r.clientCreatedAt ?? r.createdAt,
        }),
      ),
    );
    applyMessages(() => loaded.messages);
    // Everything loaded has already been distilled into the profile — it was distilled the first time
    // round. Re-running it would re-teach facts the user has since asked to forget, since the sentence
    // that taught them is still in the conversation. The predicate must stay identical to the one
    // runExtraction filters with, or the cursor indexes into a differently-shaped list.
    extractCursorRef.current = loaded.messages.filter(
      (m) => messageBodyText(m).trim() && !m.error && !m.streaming,
    ).length;
    setHistoryLoading(false);
  }

  const refreshConversations = useCallback(async () => {
    const list = await listConversations({ take: 60 });
    setConversations(list);
  }, []);

  // First load of the history. Guarded on unmount rather than left to land wherever: signing out
  // unmounts this while the request is still out, and the reply would otherwise arrive into a component
  // that no longer belongs to anyone.
  useEffect(() => {
    let alive = true;
    void listConversations({ take: 60 }).then((list) => {
      if (alive) setConversations(list);
    });
    return () => {
      alive = false;
    };
  }, []);

  // A new chat only exists to the sidebar once one of its messages has actually been recorded, and that
  // moment is not a fixed delay after sending: the recorder waits for the list to settle, so a reply that
  // streams for ten seconds — or a voice message still being transcribed — holds it off for exactly as
  // long as it takes. Waiting on the record itself is the difference between the chat you are in showing
  // up in its own history and it silently missing until the next reload.
  useEffect(() => {
    return onTranscriptRecorded((conversationId) => {
      if (conversationId === conversationIdRef.current) setActiveConvId(conversationId);
      void refreshConversations();
    });
  }, [refreshConversations]);

  /**
   * Name a conversation the first time it has something to be named after.
   *
   * Runs off the list rather than off the send path: the server is what knows whether a conversation
   * already has a name, and it only appears in the list once its opening message has been recorded —
   * which is exactly when there is something to summarise. That also means an old conversation from
   * before any of this gets named the first time you open it, rather than being stuck with its opening
   * words forever.
   *
   * Once per conversation, ever. `titledRef` stops a failed attempt from retrying on every list refresh
   * within this tab; the server's `named` flag stops it across reloads and keeps a name the user typed
   * from being overwritten by a summary.
   */
  useEffect(() => {
    const id = activeConvId;
    if (!id || historyLoading) return;
    const conv = conversations.find((c) => c.conversationId === id);
    if (!conv || conv.named || titledRef.current.has(id)) return;
    const firstUser = messagesRef.current.find((m) => m.role === "user" && messageBodyText(m).trim());
    if (!firstUser) return;
    titledRef.current.add(id);
    void (async () => {
      // The reply too, when there is one: "can you help me with this" is only nameable through what it
      // was answered with.
      const firstReply = messagesRef.current.find(
        (m) => m.role === "assistant" && !m.error && !m.streaming && messageBodyText(m).trim(),
      );
      const title = await summarizeConversationTitle(
        store.getTextModel(),
        messageBodyText(firstUser),
        firstReply ? messageBodyText(firstReply) : undefined,
      );
      // No title is a real answer — a greeting has nothing to be about — and the opening words are
      // still there to fall back on.
      if (!title) return;
      if (await setConversationTitle(id, title)) await refreshConversations();
    })();
  }, [conversations, activeConvId, historyLoading, refreshConversations]);

  /** Rename a conversation from the sidebar. An empty name forgets it, back to the opening words. */
  async function renameConversation(conversationId: string, title: string) {
    const trimmed = title.trim();
    setConversations((cur) =>
      cur.map((c) => (c.conversationId === conversationId ? { ...c, title: trimmed, named: !!trimmed } : c)),
    );
    // Renaming is also how you say "this summary was wrong", so it must stick even when it lands on a
    // conversation the summariser is about to name — marking it here keeps that call from overwriting.
    titledRef.current.add(conversationId);
    await setConversationTitle(conversationId, trimmed);
    await refreshConversations();
  }

  /**
   * Name a conversation from the whole of it, on demand — the re-generate button in the rename box.
   *
   * The automatic pass names a chat off its opening exchange, because that is all that exists when it is
   * first recorded. This one is asked for later, usually *because* that name no longer fits: a chat that
   * opened "quick question" and spent an hour on a visa application is not about a quick question.
   *
   * Reads the conversation on screen from memory and any other from the record, so the button works on
   * any row in the list rather than only the one you are in. Returns "" on failure — the box keeps what
   * it had, and nothing is saved until the user accepts it.
   */
  async function regenerateTitle(conversationId: string): Promise<string> {
    let turns: TitleTurn[];
    if (conversationId === conversationIdRef.current) {
      turns = messagesRef.current
        .filter((m) => !m.error && !m.streaming)
        .map((m) => ({ role: m.role, text: messageBodyText(m) }));
    } else {
      const loaded = await loadConversation(conversationId);
      turns = loaded.messages.map((m) => ({ role: m.role, text: messageBodyText(m) }));
    }
    const title = await regenerateConversationTitle(store.getTextModel(), turns);
    // A name the user asked for is a name they chose, so the automatic summariser must not later
    // overwrite it — same reasoning as a typed rename.
    if (title) titledRef.current.add(conversationId);
    return title;
  }

  /**
   * Take a conversation out of the history list.
   *
   * Removed from the list and nothing more: what was said stays in the record and any files stay in
   * storage, so the assistant can still recall the subject and still hand back a document from a chat
   * that has been tidied away. Wiping everything is a separate, explicit act — deleting the account.
   *
   * Deleting the conversation you are CURRENTLY in also starts a new one. Otherwise you would carry on
   * typing into a chat that is no longer listed, and every message after this point would vanish from
   * the history the moment it was written.
   */
  async function deleteConversation(conversationId: string) {
    setConversations((cur) => cur.filter((c) => c.conversationId !== conversationId));
    if (conversationId === conversationIdRef.current) startNewChat();
    else if (conversationId === activeConvId) setActiveConvId(null);
    // Refreshed either way: on success to settle the list, and on failure to put back a conversation
    // that is still there — the list must not keep claiming something that did not happen.
    await setConversationHidden(conversationId, true);
    await refreshConversations();
  }

  /** Pin or unpin from the sidebar. Flipped on screen first — a pin should feel instant — and put back
   *  if the server disagrees, so the list never shows a preference that didn't stick. */
  async function togglePin(conversationId: string, pinned: boolean) {
    setConversations((cur) => cur.map((c) => (c.conversationId === conversationId ? { ...c, pinned } : c)));
    if (await setConversationPinned(conversationId, pinned)) await refreshConversations();
    else setConversations((cur) => cur.map((c) => (c.conversationId === conversationId ? { ...c, pinned: !pinned } : c)));
  }

  return (
    <div className="app-shell flex flex-row bg-linear-to-b from-black/2 to-transparent dark:from-white/5">
      <Sidebar
        user={user}
        conversations={conversations}
        activeConversationId={activeConvId}
        historyLoading={historyLoading}
        // Neither starting a new chat nor opening a past one asks first: nothing is lost either way —
        // the thread you leave stays in the history list beside it, one tap away.
        onNewChat={startNewChat}
        onOpenConversation={(id) => void openConversation(id)}
        onTogglePin={(id, pinned) => void togglePin(id, pinned)}
        onRename={(id, title) => void renameConversation(id, title)}
        onRegenerateTitle={regenerateTitle}
        onDeleteConversation={(id) => setConfirmDeleteConv(id)}
        onOpenSettings={() => setDrawerOpen(true)}
        onSignOut={() => setConfirmLogout(true)}
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
          {/* min-w-0 + truncate so the wordmark yields rather than pushing the text-size control
              off the edge on a 320px screen. */}
          <span className="min-w-0 truncate font-semibold">EverVault</span>
          {/* Mobile-only: on a laptop the browser's own zoom is better and always at hand. */}
          <TextSizeControl value={chatScale} onChange={pickChatScale} />
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
              scale={chatScale}
              userName={user.name}
              userPicture={user.picture}
              onPlayAudio={handlePlayReplyAudio}
              playingAudioId={audioPlaying?.id ?? null}
              audioPaused={audioPlaying?.paused ?? false}
              generatingAudioIds={generatingAudio}
              onReply={setReplyTo}
              onDelete={setPendingDelete}
              onSendFile={sendStoredFile}
              onForget={confirmForget}
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
            halfDuplex={callHalfDuplex}
            onToggleMute={toggleMute}
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
        onDeleteAccount={() => {
          setDeleteAccountError("");
          setConfirmDeleteAccount(true);
        }}
      />

      <ConfirmDialog
        open={!!confirmDeleteConv}
        title={t.history.deleteTitle}
        message={t.history.deleteMessage}
        confirmLabel={t.history.delete}
        cancelLabel={t.common.cancel}
        confirmVariant="danger"
        onClose={() => setConfirmDeleteConv(null)}
        onConfirm={() => {
          const id = confirmDeleteConv;
          setConfirmDeleteConv(null);
          if (id) void deleteConversation(id);
        }}
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
        idleSeconds={liveIdleSec}
        onReconnect={() => {
          setIdleEndedOpen(false);
          void startCall(); // resume the conversation on a fresh Live socket
        }}
        onClose={() => setIdleEndedOpen(false)}
      />
    </div>
  );
}
