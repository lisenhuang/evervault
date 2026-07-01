"use client";

import { Brain, LogOut, MessageCircle, Settings2, SquarePen } from "lucide-react";
import ThemeToggle from "@/components/theme/ThemeToggle";
import LanguageToggle from "@/i18n/LanguageToggle";
import { useT } from "@/i18n/LanguageProvider";
import type { Me } from "./authApi";

const ROW =
  "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-black/70 transition hover:bg-black/5 dark:text-white/70 dark:hover:bg-white/10";

/**
 * Left navigation for the chat app. Renders the same body in two wrappers: a
 * persistent rail on desktop (md+) and a slide-in overlay on mobile (driven by
 * `open`/`onClose`, mirroring the right-side drawers). Each action closes the
 * mobile overlay after running — a harmless no-op on the persistent desktop rail.
 */
export default function Sidebar({
  user,
  textModel,
  onNewChat,
  onOpenMemories,
  onOpenSettings,
  onSignOut,
  open,
  onClose,
}: {
  user: Me;
  textModel: string;
  onNewChat: () => void;
  onOpenMemories: () => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const body = (
    <div className="flex h-full flex-col gap-1 p-3">
      <div className="flex items-center gap-2 px-2 py-2">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-linear-to-br from-blue-500 to-violet-500 shadow-sm">
          <MessageCircle size={18} className="text-white" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <div className="font-semibold leading-tight">EverVault</div>
          <div className="truncate text-xs text-black/40 dark:text-white/40">{textModel}</div>
        </div>
      </div>

      <nav className="mt-2 flex flex-col gap-0.5">
        <button onClick={act(onNewChat)} className={ROW}>
          <SquarePen size={18} className="shrink-0" aria-hidden="true" />
          {t.sidebar.newChat}
        </button>
        <button onClick={act(onOpenMemories)} className={ROW}>
          <Brain size={18} className="shrink-0" aria-hidden="true" />
          {t.sidebar.memories}
        </button>
        <button onClick={act(onOpenSettings)} className={ROW}>
          <Settings2 size={18} className="shrink-0" aria-hidden="true" />
          {t.sidebar.settings}
        </button>
      </nav>

      <div className="flex-1" />

      <div className="flex items-center justify-between rounded-lg px-3 py-1.5">
        <span className="text-sm font-medium text-black/70 dark:text-white/70">{t.sidebar.language}</span>
        <LanguageToggle variant="row" />
      </div>

      <div className="flex items-center justify-between rounded-lg px-3 py-1.5">
        <span className="text-sm font-medium text-black/70 dark:text-white/70">{t.sidebar.theme}</span>
        <ThemeToggle />
      </div>

      <div className="my-1 border-t border-black/10 dark:border-white/10" />

      <div className="flex items-center gap-2 px-2 py-2">
        {user.picture ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={user.picture}
            alt={user.name}
            className="h-8 w-8 shrink-0 rounded-full object-cover shadow-sm"
          />
        ) : (
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/10 text-xs font-semibold dark:bg-white/15">
            {(user.name || "?").charAt(0).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{user.name}</div>
        </div>
        <button
          onClick={act(onSignOut)}
          title={t.sidebar.signOut}
          aria-label={t.sidebar.signOut}
          className="rounded-md p-2 text-black/60 transition hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
        >
          <LogOut size={18} />
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop: persistent left rail */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-black/10 md:flex dark:border-white/10">
        {body}
      </aside>

      {/* Mobile: slide-in overlay (mirrors the right-side drawers, left-anchored) */}
      <div className={`fixed inset-0 z-30 md:hidden ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
        <div
          className={`absolute inset-0 bg-black/30 backdrop-blur-sm transition-opacity ${open ? "opacity-100" : "opacity-0"}`}
          onClick={onClose}
        />
        <aside
          className={`absolute top-0 left-0 flex h-full w-72 max-w-[80%] flex-col border-r border-black/10 bg-white shadow-xl transition-transform dark:border-white/10 dark:bg-neutral-950 ${
            open ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          {body}
        </aside>
      </div>
    </>
  );
}
