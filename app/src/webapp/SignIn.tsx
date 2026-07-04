import { Ionicons } from "@expo/vector-icons";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/lib/auth";
import { useColors } from "./ui/theme";

export default function SignIn() {
  const { status, signIn, signingIn, error } = useAuth();
  const c = useColors();
  const insets = useSafeAreaInsets();

  const disabled = status === "disabled";

  return (
    <View style={[styles.root, { backgroundColor: c.background, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.center}>
        <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Image source={require("../../assets/images/logo-glow.png")} style={styles.logo} resizeMode="contain" />
          <Text style={[styles.title, { color: c.text }]}>{disabled ? "Sign-in unavailable" : "Welcome to EverVault"}</Text>
          <Text style={[styles.body, { color: c.textSecondary }]}>
            {disabled
              ? "Google sign-in hasn't been enabled yet. Please try again later."
              : "Your personal AI companion that remembers your conversations. Sign in to get started."}
          </Text>

          {!disabled && (
            <Pressable
              onPress={() => void signIn()}
              disabled={signingIn}
              style={({ pressed }) => [styles.button, { backgroundColor: c.accent, opacity: pressed || signingIn ? 0.85 : 1 }]}
            >
              {signingIn ? (
                <ActivityIndicator color={c.accentText} />
              ) : (
                <>
                  <Ionicons name="logo-google" size={18} color={c.accentText} />
                  <Text style={[styles.buttonText, { color: c.accentText }]}>Continue with Google</Text>
                </>
              )}
            </Pressable>
          )}

          {error && <Text style={[styles.error, { color: c.danger }]}>{error}</Text>}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  card: {
    width: "100%",
    maxWidth: 360,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 24,
    paddingVertical: 36,
    paddingHorizontal: 28,
    alignItems: "center",
  },
  logo: { width: 96, height: 96, marginBottom: 12 },
  title: { fontSize: 22, fontWeight: "700", textAlign: "center" },
  body: { marginTop: 10, fontSize: 14, lineHeight: 20, textAlign: "center" },
  button: {
    marginTop: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    borderRadius: 999,
    paddingVertical: 14,
    paddingHorizontal: 24,
    minWidth: 220,
  },
  buttonText: { fontSize: 15, fontWeight: "600" },
  error: { marginTop: 14, fontSize: 13, textAlign: "center" },
});
