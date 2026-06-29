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

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 py-10">
      <h1 className="mb-8 text-2xl font-bold">🔐 EverVault Admin</h1>
      {view === "loading" && <p className="text-sm text-black/60 dark:text-white/60">Loading…</p>}
      {view === "setup" && <SetupForm onDone={refresh} />}
      {view === "login" && <LoginForm onDone={refresh} />}
      {view === "dashboard" && <Dashboard email={email} onLogout={refresh} />}
    </main>
  );
}
