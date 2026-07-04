import { Ionicons } from "@expo/vector-icons";
import { useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Image, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { audioModels, liveModels, type ModelInfo, PREBUILT_VOICES, textModels } from "./lib/ai";
import type { Me } from "@/lib/auth";
import { useColors } from "./ui/theme";

type Option = { value: string; label: string; sublabel?: string };

type Props = {
  visible: boolean;
  onClose: () => void;
  me: Me;
  models: ModelInfo[] | null;
  modelsLoading: boolean;
  modelsError: string;
  onReloadModels: () => void;
  textModel: string;
  audioModel: string;
  liveModel: string;
  voice: string;
  onChangeTextModel: (v: string) => void;
  onChangeAudioModel: (v: string) => void;
  onChangeLiveModel: (v: string) => void;
  onChangeVoice: (v: string) => void;
  memoryOn: boolean;
  onToggleMemory: (on: boolean) => void;
  onSignOut: () => void;
  onDeleteAccount: () => void;
};

export default function SettingsSheet(p: Props) {
  const c = useColors();
  const insets = useSafeAreaInsets();

  const textOpts = useMemo(() => toOptions(p.models ? textModels(p.models) : []), [p.models]);
  const audioOpts = useMemo(() => toOptions(p.models ? audioModels(p.models) : []), [p.models]);
  const liveOpts = useMemo(() => toOptions(p.models ? liveModels(p.models) : []), [p.models]);
  const voiceOpts = useMemo<Option[]>(() => PREBUILT_VOICES.map((v) => ({ value: v.name, label: v.name, sublabel: `${v.mood} · ${v.gender}` })), []);

  return (
    <Modal visible={p.visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={p.onClose}>
      <View style={[styles.root, { backgroundColor: c.background, paddingTop: insets.top ? 8 : 16 }]}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: c.text }]}>Settings</Text>
          <Pressable onPress={p.onClose} hitSlop={8}>
            <Ionicons name="close" size={26} color={c.textSecondary} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40, gap: 22 }}>
          <View style={[styles.account, { backgroundColor: c.surface, borderColor: c.border }]}>
            {p.me.picture ? (
              <Image source={{ uri: p.me.picture }} style={styles.avatar} />
            ) : (
              <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: c.accent }]}>
                <Text style={styles.avatarText}>{(p.me.name || p.me.email || "?").slice(0, 1).toUpperCase()}</Text>
              </View>
            )}
            <View style={{ flex: 1 }}>
              <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>{p.me.name || "You"}</Text>
              <Text style={[styles.email, { color: c.textSecondary }]} numberOfLines={1}>{p.me.email}</Text>
            </View>
          </View>

          <View style={styles.section}>
            <View style={styles.sectionHead}>
              <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>MODELS</Text>
              {p.modelsLoading ? (
                <ActivityIndicator size="small" color={c.textMuted} />
              ) : (
                <Pressable onPress={p.onReloadModels} hitSlop={8}>
                  <Ionicons name="refresh" size={16} color={c.textMuted} />
                </Pressable>
              )}
            </View>
            {p.modelsError ? <Text style={[styles.err, { color: c.danger }]}>{p.modelsError}</Text> : null}
            <Select c={c} label="Text chat" value={p.textModel} options={textOpts} onChange={p.onChangeTextModel} />
            <Select c={c} label="Spoken reply (TTS)" value={p.audioModel} options={audioOpts} onChange={p.onChangeAudioModel} />
            <Select c={c} label="Live voice call" value={p.liveModel} options={liveOpts} onChange={p.onChangeLiveModel} />
            <Select c={c} label="Voice" value={p.voice} options={voiceOpts} onChange={p.onChangeVoice} />
          </View>

          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: c.textSecondary }]}>MEMORY</Text>
            <View style={[styles.rowBetween, { backgroundColor: c.surface, borderColor: c.border }]}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={[styles.rowLabel, { color: c.text }]}>Remember our conversations</Text>
                <Text style={[styles.rowSub, { color: c.textMuted }]}>Lets EverVault recall past chats and learn about you.</Text>
              </View>
              <Switch value={p.memoryOn} onValueChange={p.onToggleMemory} />
            </View>
          </View>

          <View style={styles.section}>
            <Pressable onPress={p.onSignOut} style={[styles.actionRow, { borderColor: c.border }]}>
              <Ionicons name="log-out-outline" size={18} color={c.text} />
              <Text style={[styles.actionText, { color: c.text }]}>Sign out</Text>
            </Pressable>
            <Pressable onPress={p.onDeleteAccount} style={[styles.actionRow, { borderColor: c.border }]}>
              <Ionicons name="trash-outline" size={18} color={c.danger} />
              <Text style={[styles.actionText, { color: c.danger }]}>Delete account & all data</Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

function toOptions(models: ModelInfo[]): Option[] {
  return models.map((m) => ({ value: m.id, label: m.displayName, sublabel: m.id }));
}

function Select({ c, label, value, options, onChange }: { c: ReturnType<typeof useColors>; label: string; value: string; options: Option[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} style={[styles.selectRow, { backgroundColor: c.surface, borderColor: c.border }]}>
        <Text style={[styles.selectLabel, { color: c.textSecondary }]}>{label}</Text>
        <View style={styles.selectValue}>
          <Text style={[styles.selectValueText, { color: c.text }]} numberOfLines={1}>{current?.label ?? value}</Text>
          <Ionicons name="chevron-down" size={16} color={c.textMuted} />
        </View>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={[styles.picker, { backgroundColor: c.background, borderColor: c.border }]} onPress={() => {}}>
            <Text style={[styles.pickerTitle, { color: c.text }]}>{label}</Text>
            {options.length === 0 ? (
              <Text style={[styles.rowSub, { color: c.textMuted, padding: 16 }]}>No models available yet.</Text>
            ) : (
              <FlatList
                data={options}
                keyExtractor={(o) => o.value}
                style={{ maxHeight: 380 }}
                renderItem={({ item }) => (
                  <Pressable
                    onPress={() => {
                      onChange(item.value);
                      setOpen(false);
                    }}
                    style={styles.pickerItem}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.pickerItemText, { color: c.text }]}>{item.label}</Text>
                      {item.sublabel ? <Text style={[styles.rowSub, { color: c.textMuted }]}>{item.sublabel}</Text> : null}
                    </View>
                    {item.value === value && <Ionicons name="checkmark" size={18} color={c.accent} />}
                  </Pressable>
                )}
              />
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingBottom: 8 },
  title: { fontSize: 20, fontWeight: "700" },
  account: { flexDirection: "row", alignItems: "center", gap: 12, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 14 },
  avatar: { width: 46, height: 46, borderRadius: 23 },
  avatarFallback: { alignItems: "center", justifyContent: "center" },
  avatarText: { color: "#fff", fontSize: 18, fontWeight: "700" },
  name: { fontSize: 16, fontWeight: "600" },
  email: { fontSize: 13, marginTop: 1 },
  section: { gap: 10 },
  sectionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionTitle: { fontSize: 12, fontWeight: "700", letterSpacing: 0.6 },
  err: { fontSize: 12.5 },
  selectRow: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 12 },
  selectLabel: { fontSize: 12.5 },
  selectValue: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 4 },
  selectValueText: { fontSize: 15, fontWeight: "500", flex: 1 },
  rowBetween: { flexDirection: "row", alignItems: "center", borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14 },
  rowLabel: { fontSize: 15, fontWeight: "500" },
  rowSub: { fontSize: 12.5, marginTop: 2 },
  actionRow: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 14 },
  actionText: { fontSize: 15, fontWeight: "500" },
  backdrop: { flex: 1, backgroundColor: "#00000066", alignItems: "center", justifyContent: "center", padding: 24 },
  picker: { width: "100%", maxWidth: 420, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 12 },
  pickerTitle: { fontSize: 15, fontWeight: "700", paddingHorizontal: 16, paddingBottom: 8 },
  pickerItem: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12 },
  pickerItemText: { fontSize: 15, fontWeight: "500" },
});
