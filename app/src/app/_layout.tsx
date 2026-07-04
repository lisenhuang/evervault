import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { useColorScheme } from "@/hooks/use-color-scheme";
import { AuthProvider } from "@/lib/auth";
import { Palette } from "@/webapp/ui/theme";

export default function RootLayout() {
  const scheme = useColorScheme();
  const bg = (scheme === "dark" ? Palette.dark : Palette.light).background;

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style={scheme === "dark" ? "light" : "dark"} />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: bg } }} />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
