import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";

import { useAuth } from "@/lib/auth";
import ChatScreen from "@/webapp/ChatScreen";
import { hydrateStore } from "@/webapp/lib/store";
import SignIn from "@/webapp/SignIn";
import { useColors } from "@/webapp/ui/theme";

export default function Index() {
  const { status } = useAuth();
  const c = useColors();
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    void hydrateStore().then(() => setHydrated(true));
  }, []);

  if (!hydrated || status === "loading") {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.background }}>
        <ActivityIndicator color={c.accent} />
      </View>
    );
  }

  if (status === "signedIn") return <ChatScreen />;
  return <SignIn />;
}
