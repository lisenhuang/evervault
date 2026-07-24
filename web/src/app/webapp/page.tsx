"use client";

import { useCallback, useEffect, useState } from "react";
import { Lock } from "lucide-react";
import Chat from "./Chat";
import SignInGate from "./SignInGate";
import { api, type AuthConfig, type Me } from "./authApi";
import { clearErrorReportQueue } from "./lib/errorReport";
import { setTranscriptOutboxOwner } from "./transcriptApi";
import { store } from "./lib/store";
import { useT } from "@/i18n/LanguageProvider";

type View = "loading" | "disabled" | "signin" | "chat";

export default function WebappPage() {
  const t = useT();
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
      const meData: Me = await meRes.json();
      // The per-browser style cache belongs to one account. If a *different* user is now signed in on this
      // browser (a session can change without an explicit logout — cookie expiry, then someone else signs
      // in), drop the previous user's cached prefs so they neither show nor get pushed into the new
      // account. An empty owner (first sign-in, or a pre-feature local choice) is preserved on purpose, so
      // an existing local style still migrates up to the server. Runs before <Chat/> mounts and reads it.
      const owner = store.getStyleCacheOwner();
      if (owner && owner !== meData.email) store.clearStyleCache();
      store.setStyleCacheOwner(meData.email);
      // Same hazard, higher stakes: unsent conversation-record messages are queued per-browser, but the
      // server files them under whoever's cookie sends them. Bind the queue to this account before
      // <Chat/> mounts and flushes it, so one user's words can never be recorded into another's.
      setTranscriptOutboxOwner(meData.email);
      setMe(meData);
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
    // Drop any queued error reports so the next account signed in on this tab can't flush them under
    // its own identity (the queue is per-browser; logout is SPA-only, no reload to clear it).
    clearErrorReportQueue();
    // The conversation-record queue needs nothing here, deliberately. It is stored under this account's
    // own key and the next sign-in re-points the module at its own (see setTranscriptOutboxOwner above),
    // so another user can never flush it. Detaching it now would instead throw away the tail of the
    // conversation this user just had — <Chat/> records its final messages as it unmounts, which happens
    // after this runs.
    // Wipe the per-browser response-style cache too, so the next account signed in on this tab doesn't
    // inherit (or push up) the previous user's styles. Prefs are per-user; localStorage is per-browser.
    store.clearStyleCache();
    setMe(null);
    setView("signin");
  }

  if (view === "chat" && me) return <Chat user={me} onLogout={logout} />;

  return (
    <div className="flex min-h-dvh flex-col">
      {view === "loading" && (
        <div className="flex flex-1 items-center justify-center text-sm text-black/50 dark:text-white/50">{t.signin.loading}</div>
      )}
      {view === "disabled" && (
        <div className="flex flex-1 items-center justify-center px-4 py-16">
          <div className="w-full max-w-sm rounded-2xl border border-black/10 bg-white/70 p-8 text-center shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-black/5 dark:bg-white/10">
              <Lock className="h-6 w-6 text-black/60 dark:text-white/60" aria-hidden="true" />
            </div>
            <h1 className="text-lg font-semibold">{t.signin.disabledTitle}</h1>
            <p className="mt-2 text-sm text-black/55 dark:text-white/55">
              {t.signin.disabledBody}
            </p>
          </div>
        </div>
      )}
      {view === "signin" && clientId && <SignInGate clientId={clientId} onSignedIn={refresh} />}
    </div>
  );
}
