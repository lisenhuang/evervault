"use client";

import { useCallback, useEffect, useState } from "react";
import { Lock } from "lucide-react";
import Chat from "./Chat";
import SignInGate from "./SignInGate";
import { api, type AuthConfig, type Me } from "./authApi";

type View = "loading" | "disabled" | "signin" | "chat";

export default function WebappPage() {
  const [view, setView] = useState<View>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const cfgRes = await api("/api/auth/config");
    const cfg: AuthConfig = cfgRes.ok ? await cfgRes.json() : { enabled: false, clientId: null };
    if (!cfg.enabled || !cfg.clientId) {
      setView("disabled");
      return;
    }
    setClientId(cfg.clientId);
    const meRes = await api("/api/auth/me");
    if (meRes.ok) {
      setMe(await meRes.json());
      setView("chat");
      return;
    }
    setView("signin");
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    setMe(null);
    setView("signin");
  }

  if (view === "chat" && me) return <Chat user={me} onLogout={logout} />;

  return (
    <div className="flex min-h-screen flex-col">
      {view === "loading" && (
        <div className="flex flex-1 items-center justify-center text-sm text-black/50 dark:text-white/50">Loading…</div>
      )}
      {view === "disabled" && (
        <div className="flex flex-1 items-center justify-center px-4 py-16">
          <div className="w-full max-w-sm rounded-2xl border border-black/10 bg-white/70 p-8 text-center shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-black/5 dark:bg-white/10">
              <Lock className="h-6 w-6 text-black/60 dark:text-white/60" aria-hidden="true" />
            </div>
            <h1 className="text-lg font-semibold">Sign-in isn’t set up yet</h1>
            <p className="mt-2 text-sm text-black/55 dark:text-white/55">
              The administrator hasn’t enabled Google sign-in. Please check back soon.
            </p>
          </div>
        </div>
      )}
      {view === "signin" && clientId && <SignInGate clientId={clientId} onSignedIn={refresh} />}
    </div>
  );
}
