"use client";

import { useState } from "react";
import { api } from "./adminApi";
import AiChat from "./AiChat";
import AiKeysForm from "./AiKeysForm";
import StorageForm from "./StorageForm";
import { Button } from "./ui";

type Section = "chat" | "aikeys" | "storage";

const NAV: { key: Section; label: string; icon: string; desc: string }[] = [
  { key: "chat", label: "Assistant", icon: "💬", desc: "Chat & run actions" },
  { key: "aikeys", label: "AI Keys", icon: "🔑", desc: "Gemini & OpenRouter" },
  { key: "storage", label: "Storage", icon: "🗄️", desc: "Cloudflare R2" },
];

export default function Dashboard({ email, onLogout }: { email: string; onLogout: () => void }) {
  const [section, setSection] = useState<Section>("chat");

  async function logout() {
    await api("/api/admin/logout", { method: "POST" });
    onLogout();
  }

  return (
    <div className="min-h-screen bg-linear-to-b from-black/2 to-transparent dark:from-white/5">
      {/* Top bar */}
      <header className="sticky top-0 z-10 border-b border-black/10 bg-white/70 backdrop-blur dark:border-white/10 dark:bg-neutral-950/70">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2 font-semibold">
            <span className="text-lg">🔐</span>
            <span>EverVault</span>
            <span className="text-black/40 dark:text-white/40">/ Admin</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-black/55 sm:inline dark:text-white/55">{email}</span>
            <Button variant="ghost" size="sm" onClick={logout}>
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
              const active = section === item.key;
              return (
                <button
                  key={item.key}
                  onClick={() => setSection(item.key)}
                  className={`flex shrink-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left transition md:w-full ${
                    active
                      ? "bg-blue-600 text-white shadow-sm"
                      : "hover:bg-black/5 dark:hover:bg-white/10"
                  }`}
                >
                  <span className="text-lg">{item.icon}</span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{item.label}</span>
                    <span className={`block text-xs ${active ? "text-white/70" : "text-black/45 dark:text-white/45"}`}>
                      {item.desc}
                    </span>
                  </span>
                </button>
              );
            })}
          </nav>
        </aside>

        {/* Content */}
        <main className="min-w-0 flex-1">
          {section === "chat" && <AiChat />}
          {section === "aikeys" && <AiKeysForm />}
          {section === "storage" && <StorageForm />}
        </main>
      </div>
    </div>
  );
}
