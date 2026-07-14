"use client";

import { useEffect, useState } from "react";
import { ChevronUp, Languages, LogOut, MessageCircle, Settings2, SquarePen, SunMoon, Trash2 } from "lucide-react";
import ThemeToggle from "@/components/theme/ThemeToggle";
import LanguageMenu from "@/i18n/LanguageMenu";
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
  onOpenSettings,
  onSignOut,
  onDeleteAccount,
  open,
  onClose,
}: {
  user: Me;
  textModel: string;
  onNewChat: () => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
  onDeleteAccount: () => void;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };

  // Account menu opened by clicking the user's name (holds Delete account + Sign out).
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the menu on outside click or Escape, only while it's open. `body` is rendered in BOTH the
  // desktop rail and the mobile overlay, so we can't rely on a single ref (it would bind to only one
  // copy — clicks on the other copy would read as "outside" and close the menu on mousedown, before
  // the menu item's click fires). Match either copy's container via a data attribute instead.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.("[data-account-menu]")) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Run a menu action: close the menu, run it, and dismiss the mobile overlay.
  const runItem = (fn: () => void) => () => {
    setMenuOpen(false);
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
        <button onClick={act(onOpenSettings)} className={ROW}>
          <Settings2 size={18} className="shrink-0" aria-hidden="true" />
          {t.sidebar.settings}
        </button>
      </nav>

      <div className="flex-1" />

      <div className="flex items-center justify-between rounded-lg px-3 py-1.5">
        <span className="flex items-center gap-3 text-sm font-medium text-black/70 dark:text-white/70">
          <Languages size={18} className="shrink-0" aria-hidden="true" />
          {t.sidebar.language}
        </span>
        <LanguageMenu variant="row" />
      </div>

      <div className="flex items-center justify-between rounded-lg px-3 py-1.5">
        <span className="flex items-center gap-3 text-sm font-medium text-black/70 dark:text-white/70">
          <SunMoon size={18} className="shrink-0" aria-hidden="true" />
          {t.sidebar.theme}
        </span>
        <ThemeToggle />
      </div>

      <div className="my-1 border-t border-black/10 dark:border-white/10" />

      <div data-account-menu className="relative">
        {menuOpen && (
          <div
            role="menu"
            className="absolute bottom-full left-0 right-0 z-10 mb-2 overflow-hidden rounded-xl border border-black/10 bg-white p-1 shadow-lg dark:border-white/10 dark:bg-neutral-900"
          >
            <button
              onClick={runItem(onDeleteAccount)}
              role="menuitem"
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-red-600 transition hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              <Trash2 size={18} className="shrink-0" aria-hidden="true" />
              {t.sidebar.deleteAccount}
            </button>
            <button
              onClick={runItem(onSignOut)}
              role="menuitem"
              className={ROW}
            >
              <LogOut size={18} className="shrink-0" aria-hidden="true" />
              {t.sidebar.signOut}
            </button>
          </div>
        )}

        <button
          onClick={() => setMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={t.sidebar.accountMenu}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition hover:bg-black/5 dark:hover:bg-white/10"
        >
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
          <ChevronUp
            size={16}
            className={`shrink-0 text-black/40 transition-transform dark:text-white/40 ${menuOpen ? "" : "rotate-180"}`}
            aria-hidden="true"
          />
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
