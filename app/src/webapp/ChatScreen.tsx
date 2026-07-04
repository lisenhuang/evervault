import { Ionicons } from "@expo/vector-icons";
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder } from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Image, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/lib/auth";
import CallBar from "./CallBar";
import Composer, { type VoiceState } from "./Composer";
import {
  type Content,
  describeImage,
  listModels,
  type ModelInfo,
  streamText,
  streamTextWithTools,
  synthesizeSpeech,
  transcribeAudio,
} from "./lib/ai";
import { playPcm16, type ClipHandle } from "./lib/audio";
import type { PreparedFile } from "./lib/files";
import { LiveSession, type LiveState } from "./lib/liveCall";
import { buildRecentContext, retrieveContext } from "./lib/recall";
import { MEMORY_PERSONA, RECALL_MEMORY_DECLARATION, runRecallTool } from "./lib/recallTool";
import { extractAndSyncProfile, type Fact, getProfile, renderProfileBlock } from "./lib/profile";
import { recordTurn, type TurnItem } from "./lib/recordApi";
import { store } from "./lib/store";
import { currentTimeContext } from "./lib/time";
import { uid } from "./lib/uid";
import MessageList from "./MessageList";
import SettingsSheet from "./SettingsSheet";
import type { ChatMessage } from "./types";
import { useColors } from "./ui/theme";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

function fileToPart(f: PreparedFile) {
  if (f.kind === "text") return { text: `--- Attached file: ${f.name} ---\n${f.text ?? ""}\n--- End of file: ${f.name} ---` };
  return { inlineData: { mimeType: f.mimeType, data: f.base64 ?? "" } };
}

function toContents(msgs: ChatMessage[]): Content[] {
  return msgs
    .filter((m) => (m.text || m.files?.length) && !m.error && m.kind !== "call")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [...(m.files ?? []).map(fileToPart), ...(m.text ? [{ text: m.text }] : [])],
    }));
}

export default function ChatScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { me, signOut, deleteAccount } = useAuth();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [textModel, setTextModel] = useState(store.getTextModel());
  const [audioModel, setAudioModel] = useState(store.getAudioModel());
  const [liveModel, setLiveModel] = useState(store.getLiveModel());
  const [voice, setVoice] = useState(store.getVoice());
  const [memoryOn, setMemoryOnState] = useState(store.getMemoryOn());
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const playingRef = useRef<ClipHandle | null>(null);

  const playAudioClip = useCallback(async (base64: string, sampleRate: number) => {
    playingRef.current?.stop();
    try {
      const handle = await playPcm16(base64, sampleRate);
      playingRef.current = handle;
      void handle.ended.then(() => {
        if (playingRef.current === handle) playingRef.current = null;
      });
    } catch {
      /* playback best-effort */
    }
  }, []);

  // --- realtime call ---
  const [callState, setCallState] = useState<LiveState | null>(null);
  const [callMuted, setCallMuted] = useState(false);
  const [callError, setCallError] = useState("");
  const [callHeadphones, setCallHeadphones] = useState(store.getHeadphones());
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

  // --- memory / profile ---
  const conversationIdRef = useRef(uid());
  const profileFactsRef = useRef<Fact[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  const extractCursorRef = useRef(0);
  const extractTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const refreshProfile = useCallback(async () => {
    if (!store.getMemoryOn()) return;
    profileFactsRef.current = await getProfile();
  }, []);

  const runExtraction = useCallback(async (minNew = 2) => {
    if (!store.getMemoryOn()) return;
    const transcript = messagesRef.current
      .filter((m) => m.text && !m.error && !m.streaming && m.kind !== "call")
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

  const loadModels = useCallback(async () => {
    setModelsLoading(true);
    setModelsError("");
    try {
      setModels(await listModels());
    } catch (e) {
      setModels(null);
      setModelsError(errMsg(e));
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadModels();
    void refreshProfile();
  }, [loadModels, refreshProfile]);

  useEffect(() => () => void liveRef.current?.stop(), []);

  function setMemoryOn(on: boolean) {
    store.setMemoryOn(on);
    setMemoryOnState(on);
    if (on) void refreshProfile();
  }

  // --- assistant turn ---
  async function runAssistant(asstId: string, contents: Content[], speak: boolean): Promise<string> {
    let acc = "";
    const onDelta = (delta: string) => {
      acc += delta;
      setMessages((cur) => cur.map((m) => (m.id === asstId ? { ...m, text: acc } : m)));
    };
    if (memoryOn) {
      const sys = [renderProfileBlock(profileFactsRef.current), MEMORY_PERSONA, currentTimeContext()].filter(Boolean).join("\n\n");
      const tools = [{ functionDeclarations: [RECALL_MEMORY_DECLARATION] }];
      for await (const delta of streamTextWithTools(textModel, contents, sys, tools, (_n, args) => runRecallTool(args))) onDelta(delta);
    } else {
      for await (const delta of streamText(textModel, contents, currentTimeContext())) onDelta(delta);
    }
    const finalText = acc || "(no response)";
    setMessages((cur) => cur.map((m) => (m.id === asstId ? { ...m, streaming: false, text: finalText } : m)));
    if (speak && acc) {
      void (async () => {
        try {
          const audio = await synthesizeSpeech(audioModel, acc, voice);
          setMessages((cur) => cur.map((m) => (m.id === asstId ? { ...m, audio } : m)));
        } catch {
          /* TTS best-effort */
        }
      })();
    }
    return acc;
  }

  async function recordTextTurns(
    items: { role: "user" | "assistant"; text: string; modality: TurnItem["modality"] }[],
    extra?: { audioBase64?: string; audioMime?: string; imageBase64?: string; imageMime?: string },
  ) {
    if (!memoryOn) return;
    const { embedDocument } = await import("./lib/embed");
    const turns: TurnItem[] = [];
    for (const it of items) {
      if (!it.text.trim() && !(it.role === "user" && (extra?.audioBase64 || extra?.imageBase64))) continue;
      const embedding = it.text.trim() ? (await embedDocument(it.text)) ?? undefined : undefined;
      turns.push({
        role: it.role,
        modality: it.modality,
        text: it.text,
        embedding,
        ...(it.role === "user" && extra?.audioBase64 ? { audioBase64: extra.audioBase64, audioMime: extra.audioMime ?? "audio/mp4" } : {}),
        ...(it.role === "user" && extra?.imageBase64 ? { imageBase64: extra.imageBase64, imageMime: extra.imageMime ?? "image/jpeg" } : {}),
      });
    }
    recordTurn(conversationIdRef.current, turns);
    scheduleExtraction();
  }

  async function ragPreface(query: string): Promise<Content | null> {
    if (!memoryOn) return null;
    const recent = messagesRef.current.filter((m) => m.text && !m.error).map((m) => ({ role: m.role, text: m.text }));
    return retrieveContext({ recent, currentText: query, profileBlock: renderProfileBlock(profileFactsRef.current), nowMs: Date.now() });
  }

  // --- text message ---
  async function sendText(text: string, files?: PreparedFile[]) {
    const images = files?.filter((f) => f.kind === "image" && f.base64) ?? [];
    const userMsg: ChatMessage = { id: uid(), role: "user", text, kind: images.length ? "image" : "text", ...(files?.length ? { files } : {}) };
    const asstId = uid();
    const base = [...messages, userMsg];
    setMessages([...base, { id: asstId, role: "assistant", text: "", streaming: true }]);
    setStreaming(true);
    try {
      const preface = await ragPreface(text);
      const contents = preface ? [preface, ...toContents(base)] : toContents(base);
      const reply = await runAssistant(asstId, contents, false);
      if (files?.length) {
        void (async () => {
          const lines = await Promise.all(
            files.map(async (f) => {
              if (f.kind !== "image" || !f.base64) return `[File] ${f.name}`;
              const desc = await describeImage(textModel, f.base64, f.mimeType).catch(() => "");
              return desc ? `[Image] ${desc}` : "[Image]";
            }),
          );
          const userContent = [text.trim(), ...lines].filter(Boolean).join("\n") || "(attachment)";
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
          { role: "user", text, modality: "text" },
          { role: "assistant", text: reply, modality: "text" },
        ]);
      }
    } catch (e) {
      setMessages((cur) => cur.map((m) => (m.id === asstId ? { ...m, streaming: false, error: true, text: errMsg(e) } : m)));
    } finally {
      setStreaming(false);
    }
  }

  // --- push-to-talk voice message ---
  async function startVoice() {
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Microphone needed", "Allow microphone access to send voice messages.");
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setVoiceState("recording");
    } catch {
      setVoiceState("idle");
    }
  }

  async function stopVoice() {
    if (voiceState !== "recording") return;
    setVoiceState("processing");
    setStreaming(true);
    const userMsg: ChatMessage = { id: uid(), role: "user", text: "", kind: "voice" };
    const asstId = uid();
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) throw new Error("No recording captured.");
      const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });

      const base = [...messages, userMsg];
      setMessages([...base, { id: asstId, role: "assistant", text: "", streaming: true, kind: "voice" }]);

      const transcript = (await transcribeAudio(textModel, base64, "audio/mp4").catch(() => "")).trim();
      setMessages((cur) => cur.map((m) => (m.id === userMsg.id ? { ...m, text: transcript || "Voice message" } : m)));
      if (!transcript) {
        setMessages((cur) => cur.map((m) => (m.id === asstId ? { ...m, streaming: false, error: true, text: "I couldn't make out any speech — try again." } : m)));
        return;
      }

      const spoken: ChatMessage = { ...userMsg, text: transcript };
      const contents = toContents([...messages, spoken]);
      const reply = await runAssistant(asstId, contents, true);
      void recordTextTurns(
        [
          { role: "user", text: transcript, modality: "voice" },
          { role: "assistant", text: reply, modality: "voice" },
        ],
        { audioBase64: base64, audioMime: "audio/mp4" },
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

  // --- realtime call ---
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

  function finishCall() {
    const startedAt = callStartedAtRef.current;
    setCallStartedAt(null);
    if (startedAt == null) return;
    const durationSec = Math.floor((Date.now() - startedAt) / 1000);
    if (durationSec < 1) return;
    setMessages((cur) => [...cur, { id: uid(), role: "assistant", text: "", kind: "call", durationSec }]);
  }

  async function startCall() {
    setCallError("");
    setCallMuted(false);
    setCallStartedAt(null);
    liveUserIdRef.current = null;
    liveAsstIdRef.current = null;
    liveUserTextRef.current = "";
    liveAsstTextRef.current = "";
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Microphone needed", "Allow microphone access to start a voice call.");
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    } catch {
      /* continue — the session will surface any hard failure */
    }

    const profileBlock = memoryOn ? renderProfileBlock(profileFactsRef.current) ?? undefined : undefined;
    const recentContext = memoryOn ? (await buildRecentContext()) ?? undefined : undefined;
    const session = new LiveSession(liveModel, voice, memoryOn, profileBlock, recentContext);
    session.setHeadphones(callHeadphones);
    liveRef.current = session;
    setCallState("connecting");
    try {
      await session.start({
        onState: (s) => {
          setCallState(s);
          if ((s === "listening" || s === "speaking") && callStartedAtRef.current == null) setCallStartedAt(Date.now());
        },
        onUserText: (d) => appendLiveText("user", d),
        onModelText: (d) => appendLiveText("assistant", d),
        onTurnComplete: () => {
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

  function toggleHeadphones() {
    const next = !callHeadphones;
    setCallHeadphones(next);
    store.setHeadphones(next);
    liveRef.current?.setHeadphones(next);
  }

  // Auto-cleanup when a call ends on its own (server/network drop).
  useEffect(() => {
    if (callState !== "closed" && callState !== "error") return;
    void liveRef.current?.stop();
    liveRef.current = null;
    finishCall();
    if (callState === "closed") {
      const t = setTimeout(() => setCallState(null), 1500);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callState]);

  function newChat() {
    if (callState) void endCall();
    void runExtraction(2);
    setMessages([]);
    conversationIdRef.current = uid();
    extractCursorRef.current = 0;
  }

  function confirmSignOut() {
    Alert.alert("Sign out?", "You'll need to sign in again to use EverVault.", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: () => void signOut() },
    ]);
  }

  function confirmDeleteAccount() {
    Alert.alert(
      "Delete account?",
      "This permanently deletes your account and ALL your data — chat memories, profile, and stored audio. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete everything",
          style: "destructive",
          onPress: async () => {
            const ok = await deleteAccount();
            if (!ok) Alert.alert("Couldn't delete", "Something went wrong. Please try again.");
          },
        },
      ],
    );
  }

  const firstName = me?.name?.split(" ")[0] || "there";

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: c.background }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={[styles.header, { borderBottomColor: c.border, paddingTop: insets.top + 6 }]}>
        <Image source={require("../../assets/images/logo-glow.png")} style={styles.headerLogo} resizeMode="contain" />
        <Text style={[styles.headerTitle, { color: c.text }]}>EverVault</Text>
        <View style={styles.headerActions}>
          <Pressable onPress={newChat} hitSlop={8} style={styles.headerBtn}>
            <Ionicons name="create-outline" size={22} color={c.textSecondary} />
          </Pressable>
          <Pressable onPress={() => setSettingsOpen(true)} hitSlop={8} style={styles.headerBtn}>
            <Ionicons name="settings-outline" size={21} color={c.textSecondary} />
          </Pressable>
        </View>
      </View>

      {messages.length === 0 ? (
        <View style={styles.empty}>
          <Image source={require("../../assets/images/logo-glow.png")} style={styles.emptyLogo} resizeMode="contain" />
          <Text style={[styles.greeting, { color: c.text }]}>Hi {firstName}</Text>
          <Text style={[styles.emptyBody, { color: c.textSecondary }]}>
            Ask me anything, send a voice message, or tap the phone to talk. I'll remember what matters.
          </Text>
        </View>
      ) : (
        <MessageList messages={messages} onPlayAudio={(m) => m.audio && playAudioClip(m.audio.base64, m.audio.sampleRate)} scrollSignal={!!callState} />
      )}

      {callState && (
        <CallBar
          state={callState}
          muted={callMuted}
          error={callError}
          startedAt={callStartedAt}
          halfDuplex={!callHeadphones}
          headphones={callHeadphones}
          onToggleMute={toggleMute}
          onToggleHeadphones={toggleHeadphones}
          onInterrupt={() => liveRef.current?.interrupt()}
          onEnd={endCall}
        />
      )}

      <View style={{ paddingBottom: insets.bottom }}>
        <Composer
          onSendText={sendText}
          onStartVoice={startVoice}
          onStopVoice={stopVoice}
          onStartCall={startCall}
          voiceState={voiceState}
          disabled={streaming}
          inCall={!!callState}
          onNotice={(msg) => Alert.alert("Attachment", msg)}
        />
      </View>

      {me && (
        <SettingsSheet
          visible={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          me={me}
          models={models}
          modelsLoading={modelsLoading}
          modelsError={modelsError}
          onReloadModels={loadModels}
          textModel={textModel}
          audioModel={audioModel}
          liveModel={liveModel}
          voice={voice}
          onChangeTextModel={(v) => {
            store.setTextModel(v);
            setTextModel(v);
          }}
          onChangeAudioModel={(v) => {
            store.setAudioModel(v);
            setAudioModel(v);
          }}
          onChangeLiveModel={(v) => {
            store.setLiveModel(v);
            setLiveModel(v);
          }}
          onChangeVoice={(v) => {
            store.setVoice(v);
            setVoice(v);
          }}
          memoryOn={memoryOn}
          onToggleMemory={setMemoryOn}
          onSignOut={confirmSignOut}
          onDeleteAccount={confirmDeleteAccount}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  headerLogo: { width: 26, height: 26 },
  headerTitle: { fontSize: 17, fontWeight: "700", flex: 1 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 6 },
  headerBtn: { padding: 4 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, gap: 8 },
  emptyLogo: { width: 84, height: 84, marginBottom: 8 },
  greeting: { fontSize: 24, fontWeight: "700" },
  emptyBody: { fontSize: 15, lineHeight: 21, textAlign: "center" },
});
