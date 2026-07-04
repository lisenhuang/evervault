import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { LiveState } from "./lib/liveCall";
import { formatDuration } from "./lib/time";
import { useColors } from "./ui/theme";

type Props = {
  state: LiveState;
  muted: boolean;
  error: string;
  startedAt: number | null;
  halfDuplex: boolean;
  headphones: boolean;
  onToggleMute: () => void;
  onToggleHeadphones: () => void;
  onInterrupt: () => void;
  onEnd: () => void;
};

export default function CallBar({ state, muted, error, startedAt, halfDuplex, headphones, onToggleMute, onToggleHeadphones, onInterrupt, onEnd }: Props) {
  const c = useColors();
  const [, tick] = useState(0);

  useEffect(() => {
    if (startedAt == null) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const label =
    state === "connecting" ? "Connecting…" :
    state === "speaking" ? "Speaking…" :
    state === "listening" ? "Listening…" :
    state === "error" ? "Call error" : "Call ended";
  const elapsed = startedAt != null ? formatDuration((Date.now() - startedAt) / 1000) : "00:00";
  const speaking = state === "speaking";

  return (
    <View style={[styles.bar, { backgroundColor: c.callBg }]}>
      <View style={styles.left}>
        <View style={[styles.dot, { backgroundColor: state === "error" ? c.danger : speaking ? c.accent : c.success }]} />
        <View>
          <Text style={[styles.label, { color: c.onCall }]}>{error || label}</Text>
          {startedAt != null && !error && <Text style={styles.timer}>{elapsed}</Text>}
        </View>
      </View>

      <View style={styles.actions}>
        {halfDuplex && speaking && (
          <Pressable onPress={onInterrupt} style={[styles.action, { backgroundColor: "#ffffff22" }]} hitSlop={6}>
            <Ionicons name="hand-left" size={18} color={c.onCall} />
          </Pressable>
        )}
        <Pressable onPress={onToggleHeadphones} style={[styles.action, { backgroundColor: headphones ? c.accent : "#ffffff22" }]} hitSlop={6}>
          <Ionicons name="headset" size={18} color={c.onCall} />
        </Pressable>
        <Pressable onPress={onToggleMute} style={[styles.action, { backgroundColor: muted ? c.danger : "#ffffff22" }]} hitSlop={6}>
          <Ionicons name={muted ? "mic-off" : "mic"} size={18} color={c.onCall} />
        </Pressable>
        <Pressable onPress={onEnd} style={[styles.action, styles.end]} hitSlop={6}>
          <Ionicons name="call" size={18} color="#fff" />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12, marginHorizontal: 10, marginBottom: 8, borderRadius: 18 },
  left: { flexDirection: "row", alignItems: "center", gap: 10 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  label: { fontSize: 14, fontWeight: "600" },
  timer: { fontSize: 12, color: "#ffffff99", marginTop: 1 },
  actions: { flexDirection: "row", alignItems: "center", gap: 8 },
  action: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  end: { backgroundColor: "#DC2626", transform: [{ rotate: "135deg" }] },
});
