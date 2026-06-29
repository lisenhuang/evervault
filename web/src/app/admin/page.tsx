"use client";

import { useCallback, useEffect, useState } from "react";
import Dashboard from "./Dashboard";
import LoginForm from "./LoginForm";
import SetupForm from "./SetupForm";

type View = "loading" | "setup" | "login" | "dashboard";

export default function AdminPage() {
  const [view, setView] = useState<View>("loading");
  const [email, setEmail] = useState("");

  const refresh = useCallback(async () => {
    // Already signed in?
    const me = await fetch("/api/admin/me", { credentials: "include" });
    if (me.ok) {
      const data = await me.json();
      setEmail(data.email ?? "");
      setView("dashboard");
      return;
    }
    // Not signed in: first-run setup, or login? (server is the source of truth)
    const res = await fetch("/api/admin/status", { credentials: "include" });
    const status = await res.json();
    setView(status.initialized ? "login" : "setup");
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The dashboard is a full-width control panel; auth screens are a centered card.
  if (view === "dashboard") return <Dashboard email={email} onLogout={refresh} />;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold">🔐 EverVault Admin</h1>
        <p className="mt-1 text-sm text-black/55 dark:text-white/55">Control panel</p>
      </div>
      {view === "loading" && <p className="text-center text-sm text-black/60 dark:text-white/60">Loading…</p>}
      {view === "setup" && <SetupForm onDone={refresh} />}
      {view === "login" && <LoginForm onDone={refresh} />}
    </main>
  );
}
