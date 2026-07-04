import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { formatSize, inlineSize, MAX_FILES, MAX_TOTAL_INLINE, pickDocuments, pickImages, type PreparedFile } from "./lib/files";
import { useColors } from "./ui/theme";

export type VoiceState = "idle" | "recording" | "processing";

type Props = {
  onSendText: (text: string, files?: PreparedFile[]) => void;
  onStartVoice: () => void;
  onStopVoice: () => void;
  onStartCall: () => void;
  voiceState: VoiceState;
  disabled: boolean;
  inCall: boolean;
  onNotice: (msg: string) => void;
};

export default function Composer({ onSendText, onStartVoice, onStopVoice, onStartCall, voiceState, disabled, inCall, onNotice }: Props) {
  const c = useColors();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<PreparedFile[]>([]);

  const recording = voiceState === "recording";
  const processing = voiceState === "processing";
  const canSend = (text.trim().length > 0 || files.length > 0) && !disabled;

  function addFiles(picked: PreparedFile[], errors: string[]) {
    if (errors.length) onNotice(errors[0]);
    if (!picked.length) return;
    setFiles((cur) => {
      const merged = [...cur];
      let total = cur.reduce((s, f) => s + inlineSize(f), 0);
      for (const f of picked) {
        if (merged.length >= MAX_FILES) {
          onNotice(`You can attach up to ${MAX_FILES} files.`);
          break;
        }
        const size = inlineSize(f);
        if (total + size > MAX_TOTAL_INLINE) {
          onNotice("That would exceed the attachment size limit.");
          break;
        }
        merged.push(f);
        total += size;
      }
      return merged;
    });
  }

  async function onPickImages() {
    try {
      const { files: picked, errors } = await pickImages();
      addFiles(picked, errors);
    } catch {
      onNotice("Couldn't open the photo library.");
    }
  }

  async function onPickDocuments() {
    try {
      const { files: picked, errors } = await pickDocuments();
      addFiles(picked, errors);
    } catch {
      onNotice("Couldn't open the document picker.");
    }
  }

  function send() {
    if (!canSend) return;
    onSendText(text.trim(), files.length ? files : undefined);
    setText("");
    setFiles([]);
  }

  return (
    <View style={[styles.wrap, { backgroundColor: c.background, borderTopColor: c.border }]}>
      {files.length > 0 && (
        <View style={styles.chipsRow}>
          {files.map((f) => (
            <View key={f.id} style={[styles.chip, { backgroundColor: c.surfaceAlt }]}>
              <Ionicons name={f.kind === "image" ? "image-outline" : "document-text-outline"} size={13} color={c.textSecondary} />
              <Text numberOfLines={1} style={[styles.chipText, { color: c.text }]}>
                {f.name}
              </Text>
              <Text style={[styles.chipSize, { color: c.textMuted }]}>{formatSize(f.size)}</Text>
              <Pressable onPress={() => setFiles((cur) => cur.filter((x) => x.id !== f.id))} hitSlop={8}>
                <Ionicons name="close-circle" size={16} color={c.textMuted} />
              </Pressable>
            </View>
          ))}
        </View>
      )}

      <View style={styles.inputRow}>
        <Pressable onPress={onPickImages} disabled={disabled || inCall} hitSlop={6} style={styles.iconBtn}>
          <Ionicons name="image-outline" size={22} color={disabled || inCall ? c.textMuted : c.textSecondary} />
        </Pressable>
        <Pressable onPress={onPickDocuments} disabled={disabled || inCall} hitSlop={6} style={styles.iconBtn}>
          <Ionicons name="attach" size={22} color={disabled || inCall ? c.textMuted : c.textSecondary} />
        </Pressable>

        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={inCall ? "On a call…" : "Message"}
          placeholderTextColor={c.textMuted}
          editable={!disabled && !inCall}
          multiline
          style={[styles.input, { color: c.text, backgroundColor: c.surface, borderColor: c.border }]}
        />

        {canSend ? (
          <Pressable onPress={send} style={[styles.sendBtn, { backgroundColor: c.accent }]}>
            <Ionicons name="arrow-up" size={20} color={c.accentText} />
          </Pressable>
        ) : processing ? (
          <View style={[styles.sendBtn, { backgroundColor: c.surfaceAlt }]}>
            <ActivityIndicator size="small" color={c.textSecondary} />
          </View>
        ) : (
          <>
            <Pressable
              onPressIn={() => !disabled && !inCall && onStartVoice()}
              onPressOut={() => recording && onStopVoice()}
              disabled={disabled || inCall}
              style={[styles.roundBtn, { backgroundColor: recording ? c.danger : c.surfaceAlt }]}
            >
              <Ionicons name="mic" size={20} color={recording ? "#fff" : disabled || inCall ? c.textMuted : c.textSecondary} />
            </Pressable>
            <Pressable
              onPress={onStartCall}
              disabled={disabled || inCall}
              style={[styles.roundBtn, { backgroundColor: c.accent }]}
            >
              <Ionicons name="call" size={19} color={c.accentText} />
            </Pressable>
          </>
        )}
      </View>
      {recording && <Text style={[styles.hint, { color: c.danger }]}>Release to send · hold to keep recording</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 8 },
  chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingBottom: 8 },
  chip: { flexDirection: "row", alignItems: "center", gap: 5, borderRadius: 10, paddingLeft: 8, paddingRight: 6, paddingVertical: 5, maxWidth: 200 },
  chipText: { fontSize: 12.5, flexShrink: 1 },
  chipSize: { fontSize: 11 },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 6 },
  iconBtn: { paddingBottom: 8, paddingHorizontal: 2 },
  input: { flex: 1, minHeight: 42, maxHeight: 130, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, fontSize: 16 },
  sendBtn: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center" },
  roundBtn: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center" },
  hint: { fontSize: 11.5, textAlign: "center", marginTop: 6 },
});
