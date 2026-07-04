import { Ionicons } from "@expo/vector-icons";
import { useEffect, useRef } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { formatDuration } from "./lib/time";
import type { ChatMessage } from "./types";
import { useColors } from "./ui/theme";

type Props = {
  messages: ChatMessage[];
  onPlayAudio: (m: ChatMessage) => void;
  scrollSignal?: boolean;
};

export default function MessageList({ messages, onPlayAudio, scrollSignal }: Props) {
  const c = useColors();
  const ref = useRef<ScrollView>(null);

  useEffect(() => {
    const t = setTimeout(() => ref.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(t);
  }, [messages, scrollSignal]);

  return (
    <ScrollView
      ref={ref}
      style={styles.list}
      contentContainerStyle={styles.content}
      onContentSizeChange={() => ref.current?.scrollToEnd({ animated: false })}
      keyboardDismissMode="interactive"
    >
      {messages.map((m) => (
        <Bubble key={m.id} m={m} onPlayAudio={onPlayAudio} c={c} />
      ))}
    </ScrollView>
  );
}

function Bubble({ m, onPlayAudio, c }: { m: ChatMessage; onPlayAudio: (m: ChatMessage) => void; c: ReturnType<typeof useColors> }) {
  if (m.kind === "call") {
    return (
      <View style={styles.callChipRow}>
        <View style={[styles.callChip, { backgroundColor: c.surfaceAlt }]}>
          <Ionicons name="call" size={13} color={c.textSecondary} />
          <Text style={[styles.callChipText, { color: c.textSecondary }]}>
            Call ended · {formatDuration(m.durationSec ?? 0)}
          </Text>
        </View>
      </View>
    );
  }

  const isUser = m.role === "user";
  const images = m.files?.filter((f) => f.kind === "image" && f.uri) ?? [];
  const otherFiles = m.files?.filter((f) => f.kind !== "image") ?? [];
  const bubbleBg = m.error ? c.danger + "22" : isUser ? c.bubbleUser : c.bubbleAssistant;
  const textColor = m.error ? c.danger : isUser ? c.bubbleUserText : c.bubbleAssistantText;

  return (
    <View style={[styles.row, { justifyContent: isUser ? "flex-end" : "flex-start" }]}>
      <View style={[styles.bubble, { backgroundColor: bubbleBg, borderColor: c.border }]}>
        {images.length > 0 && (
          <View style={styles.imageRow}>
            {images.map((f) => (
              <Image key={f.id} source={{ uri: f.uri }} style={styles.thumb} />
            ))}
          </View>
        )}
        {otherFiles.map((f) => (
          <View key={f.id} style={[styles.fileChip, { borderColor: isUser ? "#ffffff55" : c.border }]}>
            <Ionicons name="document-text-outline" size={13} color={textColor} />
            <Text numberOfLines={1} style={[styles.fileName, { color: textColor }]}>
              {f.name}
            </Text>
          </View>
        ))}

        {m.kind === "voice" && !m.text ? (
          <View style={styles.voiceRow}>
            <Ionicons name="mic" size={14} color={textColor} />
            <Text style={[styles.text, { color: textColor, fontStyle: "italic" }]}>Voice message</Text>
          </View>
        ) : m.text ? (
          <Text style={[styles.text, { color: textColor }]}>{m.text}</Text>
        ) : null}

        {m.streaming && !m.text && <ActivityIndicator size="small" color={textColor} style={{ marginTop: 2 }} />}

        {m.audio && (
          <Pressable onPress={() => onPlayAudio(m)} style={[styles.playBtn, { borderColor: c.border }]}>
            <Ionicons name="volume-high" size={14} color={c.accent} />
            <Text style={[styles.playText, { color: c.accent }]}>Play reply</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  content: { paddingHorizontal: 12, paddingVertical: 16, gap: 10 },
  row: { flexDirection: "row", width: "100%" },
  bubble: { maxWidth: "84%", borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10, borderWidth: StyleSheet.hairlineWidth },
  text: { fontSize: 15.5, lineHeight: 22 },
  voiceRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  imageRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 6 },
  thumb: { width: 120, height: 120, borderRadius: 12, backgroundColor: "#00000010" },
  fileChip: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 5, marginBottom: 6, maxWidth: 220 },
  fileName: { fontSize: 12.5, flexShrink: 1 },
  playBtn: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", marginTop: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  playText: { fontSize: 12.5, fontWeight: "600" },
  callChipRow: { alignItems: "center", width: "100%" },
  callChip: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  callChipText: { fontSize: 12.5, fontWeight: "500" },
});
