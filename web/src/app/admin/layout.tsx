"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api } from "./adminApi";
import LoginForm from "./LoginForm";
import SetupForm from "./SetupForm";
import { Button } from "./ui";
import ConfirmDialog from "@/components/ConfirmDialog";
import ThemeToggle from "@/components/theme/ThemeToggle";
import { MessageCircle, KeyRound, Database, Table2, LockOpen, Shield, Bug, type LucideIcon } from "lucide-react";

type View = "loading" | "setup" | "login" | "dashboard";

const NAV: { href: string; label: string; icon: LucideIcon; desc: string }[] = [
  { href: "/admin/chat", label: "Assistant", icon: MessageCircle, desc: "Chat & run actions" },
  { href: "/admin/ai-keys", label: "AI Keys", icon: KeyRound, desc: "Gemini, OpenRouter & ChatGPT" },
  { href: "/admin/storage", label: "Storage", icon: Database, desc: "Cloudflare R2" },
  { href: "/admin/database", label: "Database", icon: Table2, desc: "Browse tables (read-only)" },
  { href: "/admin/errors", label: "Error Reports", icon: Bug, desc: "Look up reference codes" },
  { href: "/admin/google", label: "Google Login", icon: LockOpen, desc: "Sign-in & binding" },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const [view, setView] = useState<View>("loading");
  const [email, setEmail] = useState("");
  const [confirmLogout, setConfirmLogout] = useState(false);
  const pathname = usePathname();

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

  async function logout() {
    await api("/api/admin/logout", { method: "POST" });
    await refresh();
  }

  // Auth screens are a centered card; protected pages stay unmounted until signed in.
  if (view !== "dashboard") {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
        <div className="mb-8 text-center">
          <h1 className="inline-flex items-center justify-center gap-2 text-2xl font-bold">
            <Shield className="h-6 w-6" aria-hidden="true" />
            EverVault Admin
          </h1>
          <p className="mt-1 text-sm text-black/55 dark:text-white/55">Control panel</p>
        </div>
        {view === "loading" && <p className="text-center text-sm text-black/60 dark:text-white/60">Loading…</p>}
        {view === "setup" && <SetupForm onDone={refresh} />}
        {view === "login" && <LoginForm onDone={refresh} />}
      </main>
    );
  }

  // The dashboard is a full-width control panel shared across every /admin/* section.
  return (
    <div className="min-h-screen bg-linear-to-b from-black/2 to-transparent dark:from-white/5">
      {/* Top bar */}
      <header className="sticky top-0 z-10 border-b border-black/10 bg-white/70 backdrop-blur dark:border-white/10 dark:bg-neutral-950/70">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2 font-semibold">
            <Shield className="h-5 w-5" aria-hidden="true" />
            <span>EverVault</span>
            <span className="text-black/40 dark:text-white/40">/ Admin</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-black/55 sm:inline dark:text-white/55">{email}</span>
            <ThemeToggle />
            <Button variant="ghost" size="sm" onClick={() => setConfirmLogout(true)}>
              Log out
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 md:flex-row">
        {/* Sidebar nav */}
        <aside className="md:w-56 md:shrink-0">
          <nav className="flex gap-2 overflow-x-auto md:flex-col md:overflow-visible">
            {NAV.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex shrink-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left transition md:w-full ${
                    active
                      ? "bg-blue-600 text-white shadow-sm"
                      : "hover:bg-black/5 dark:hover:bg-white/10"
                  }`}
                >
                  <item.icon size={18} className="shrink-0" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{item.label}</span>
                    <span className={`block text-xs ${active ? "text-white/70" : "text-black/45 dark:text-white/45"}`}>
                      {item.desc}
                    </span>
                  </span>
                </Link>
              );
            })}
          </nav>
        </aside>

        {/* Content */}
        <main className="min-w-0 flex-1">{children}</main>
      </div>

      <ConfirmDialog
        open={confirmLogout}
        title="Log out?"
        message="You’ll need to sign in again to access the admin panel."
        confirmLabel="Log out"
        confirmVariant="danger"
        onClose={() => setConfirmLogout(false)}
        onConfirm={async () => {
          setConfirmLogout(false);
          await logout();
        }}
      />
    </div>
  );
}
