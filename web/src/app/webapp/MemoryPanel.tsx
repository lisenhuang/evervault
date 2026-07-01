"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Briefcase,
  Heart,
  History,
  ListTodo,
  Loader2,
  type LucideIcon,
  Search,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Target,
  Trash2,
  User,
  Users,
  Volume2,
  X,
} from "lucide-react";
import { embedQuery, getEmbeddingPolicy } from "./lib/embed";
import { clearProfile, deleteFact, type Fact, getProfile } from "./lib/profile";
import { clearAllMemories, deleteMemory, type MemoryHit, searchMemories } from "./recordApi";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useT } from "@/i18n/LanguageProvider";

type Tab = "about" | "history";

// Icons are stable; the human-readable category labels come from the translation dictionary
// (t.memory.categories[key]) so the underlying category KEYS stay unchanged for the backend.
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  identity: User,
  preferences: SlidersHorizontal,
  relationships: Users,
  work: Briefcase,
  goals: Target,
  interests: Heart,
  open_loop: ListTodo,
  other: Tag,
};
const CATEGORY_ORDER = Object.keys(CATEGORY_ICONS);

export default function MemoryPanel({
  open,
  onClose,
  memoryOn,
}: {
  open: boolean;
  onClose: () => void;
  memoryOn: boolean;
}) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("about");

  // About you (derived profile)
  const [facts, setFacts] = useState<Fact[] | null>(null);
  const [confirmDeleteFactId, setConfirmDeleteFactId] = useState<number | null>(null);
  const [confirmClearProfile, setConfirmClearProfile] = useState(false);

  // History (raw turns)
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<MemoryHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);

  // Semantic recall is only available once an admin has locked an embedding model; surface when it's off.
  const [embeddingOff, setEmbeddingOff] = useState(false);

  // Load the profile when the panel opens on the About tab; clear the cache on close so it's fresh next time.
  useEffect(() => {
    if (open && tab === "about" && facts === null) void getProfile().then(setFacts);
  }, [open, tab, facts]);
  useEffect(() => {
    if (!open) setFacts(null);
  }, [open]);
  useEffect(() => {
    if (open) void getEmbeddingPolicy().then((p) => setEmbeddingOff(!p.enabled));
  }, [open]);

  async function removeFact(id: number) {
    await deleteFact(id);
    setFacts((cur) => cur?.filter((f) => f.id !== id) ?? null);
  }
  async function clearAllProfile() {
    await clearProfile();
    setFacts([]);
  }

  async function run() {
    const query = q.trim();
    setBusy(true);
    const vector = query ? await embedQuery(query) : null;
    const results = await searchMemories(vector, query, 20);
    setHits(results);
    setBusy(false);
  }
  async function remove(id: number) {
    await deleteMemory(id);
    setHits((cur) => cur?.filter((h) => h.id !== id) ?? null);
  }
  async function clearAll() {
    await clearAllMemories();
    setHits([]);
  }
  function play(id: number) {
    void new Audio(`/api/chat/memories/${id}/audio`).play().catch(() => {});
  }

  const catLabel = (cat: string) => t.memory.categories[cat] ?? cat;
  const grouped = facts
    ? CATEGORY_ORDER.map((cat) => ({
        cat,
        Icon: CATEGORY_ICONS[cat],
        label: catLabel(cat),
        items: facts.filter((f) => f.category === cat),
      })).filter((g) => g.items.length > 0)
    : [];
  const ungrouped = facts ? facts.filter((f) => !CATEGORY_ICONS[f.category]) : [];

  const tabBtn = (id: Tab, label: string, Icon: LucideIcon) => (
    <button
      onClick={() => setTab(id)}
      className={`flex flex-1 items-center justify-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition ${
        tab === id
          ? "border-blue-600 text-blue-700 dark:border-blue-400 dark:text-blue-300"
          : "border-transparent text-black/50 hover:text-black/80 dark:text-white/50 dark:hover:text-white/80"
      }`}
    >
      <Icon size={16} />
      {label}
    </button>
  );

  return (
    <div className={`fixed inset-0 z-30 ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
      <div
        className={`absolute inset-0 bg-black/30 backdrop-blur-sm transition-opacity ${open ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
      />
      <aside
        className={`absolute top-0 right-0 flex h-full w-full max-w-md flex-col border-l border-black/10 bg-white shadow-xl transition-transform dark:border-white/10 dark:bg-neutral-950 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <header className="flex items-center justify-between border-b border-black/10 px-5 py-4 dark:border-white/10">
          <h2 className="font-semibold">{t.memory.title}</h2>
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-black/5 dark:hover:bg-white/10" aria-label={t.memory.close}>
            <X size={18} />
          </button>
        </header>

        <div className="flex border-b border-black/10 dark:border-white/10">
          {tabBtn("about", t.memory.tabAbout, Sparkles)}
          {tabBtn("history", t.memory.tabHistory, History)}
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
          {memoryOn && embeddingOff && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{t.memory.recallLimited}</span>
            </div>
          )}

          {tab === "about" ? (
            <>
              <p className="text-xs text-black/55 dark:text-white/55">
                {t.memory.aboutDesc}
              </p>

              {facts === null && (
                <div className="flex items-center gap-2 text-sm text-black/50 dark:text-white/50">
                  <Loader2 size={16} className="animate-spin" /> {t.memory.loading}
                </div>
              )}

              {facts && facts.length === 0 && (
                <p className="rounded-lg border border-dashed border-black/15 px-4 py-6 text-center text-sm text-black/50 dark:border-white/15 dark:text-white/50">
                  {t.memory.aboutEmpty}
                </p>
              )}

              {[...grouped, ...(ungrouped.length ? [{ cat: "other", Icon: CATEGORY_ICONS.other, label: catLabel("other"), items: ungrouped }] : [])].map(
                (g) => (
                  <div key={g.cat} className="space-y-2">
                    <div className="flex items-center gap-2 text-xs font-semibold tracking-wide text-black/45 uppercase dark:text-white/45">
                      <g.Icon size={14} />
                      {g.label}
                    </div>
                    <ul className="space-y-1.5">
                      {g.items.map((f) => (
                        <li
                          key={f.id}
                          className="group flex items-start gap-2 rounded-lg border border-black/10 px-3 py-2 text-sm dark:border-white/10"
                        >
                          <span className="flex-1 break-words">{f.value}</span>
                          <button
                            onClick={() => setConfirmDeleteFactId(f.id)}
                            className="rounded p-1 text-black/30 transition hover:bg-red-50 hover:text-red-600 dark:text-white/30 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                            aria-label={t.memory.forgetThis}
                          >
                            <Trash2 size={14} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ),
              )}

              {facts && facts.length > 0 && (
                <button onClick={() => setConfirmClearProfile(true)} className="text-xs text-red-600 hover:underline dark:text-red-400">
                  {t.memory.clearProfile}
                </button>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <div className="flex flex-1 items-center gap-2 rounded-lg border border-black/15 px-3 py-2 dark:border-white/20">
                  <Search size={16} className="text-black/40 dark:text-white/40" />
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && run()}
                    placeholder={t.memory.searchPlaceholder}
                    className="flex-1 bg-transparent text-base outline-none md:text-sm"
                  />
                </div>
                <button
                  onClick={run}
                  disabled={busy}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
                >
                  {busy ? <Loader2 size={16} className="animate-spin" /> : t.memory.search}
                </button>
              </div>

              {hits && hits.length === 0 && (
                <p className="text-sm text-black/50 dark:text-white/50">{t.memory.noMatches}</p>
              )}

              <ul className="space-y-2">
                {hits?.map((h) => (
                  <li key={h.id} className="rounded-lg border border-black/10 px-3 py-2.5 text-sm dark:border-white/10">
                    <div className="mb-1 flex items-center gap-2 text-xs text-black/45 dark:text-white/45">
                      <span className="rounded-full bg-black/10 px-2 py-0.5 dark:bg-white/10">
                        {h.role === "assistant" ? t.memory.roleAI : t.memory.roleYou}
                      </span>
                      <span>{new Date(h.createdAt).toLocaleString()}</span>
                      <span className="ml-auto flex items-center gap-1">
                        {h.hasAudio && (
                          <button onClick={() => play(h.id)} className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/10" aria-label={t.memory.playAudio}>
                            <Volume2 size={14} />
                          </button>
                        )}
                        <button onClick={() => setConfirmDeleteId(h.id)} className="rounded p-1 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40" aria-label={t.memory.delete}>
                          <Trash2 size={14} />
                        </button>
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap break-words">{h.content}</p>
                  </li>
                ))}
              </ul>

              {hits && hits.length > 0 && (
                <button onClick={() => setConfirmClearAll(true)} className="text-xs text-red-600 hover:underline dark:text-red-400">
                  {t.memory.clearAll}
                </button>
              )}
            </>
          )}
        </div>
      </aside>

      <ConfirmDialog
        open={confirmDeleteFactId !== null}
        title={t.memory.forgetFactTitle}
        message={t.memory.forgetFactMessage}
        confirmLabel={t.memory.forgetFactConfirm}
        cancelLabel={t.common.cancel}
        confirmVariant="danger"
        onClose={() => setConfirmDeleteFactId(null)}
        onConfirm={async () => {
          const id = confirmDeleteFactId;
          setConfirmDeleteFactId(null);
          if (id !== null) await removeFact(id);
        }}
      />

      <ConfirmDialog
        open={confirmClearProfile}
        title={t.memory.clearProfileTitle}
        message={t.memory.clearProfileMessage}
        confirmLabel={t.memory.clearProfileConfirm}
        cancelLabel={t.common.cancel}
        confirmVariant="danger"
        onClose={() => setConfirmClearProfile(false)}
        onConfirm={async () => {
          setConfirmClearProfile(false);
          await clearAllProfile();
        }}
      />

      <ConfirmDialog
        open={confirmDeleteId !== null}
        title={t.memory.deleteMemoryTitle}
        message={t.memory.deleteMemoryMessage}
        confirmLabel={t.memory.deleteMemoryConfirm}
        cancelLabel={t.common.cancel}
        confirmVariant="danger"
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={async () => {
          const id = confirmDeleteId;
          setConfirmDeleteId(null);
          if (id !== null) await remove(id);
        }}
      />

      <ConfirmDialog
        open={confirmClearAll}
        title={t.memory.clearAllTitle}
        message={t.memory.clearAllMessage}
        confirmLabel={t.memory.clearAllConfirm}
        cancelLabel={t.common.cancel}
        confirmVariant="danger"
        onClose={() => setConfirmClearAll(false)}
        onConfirm={async () => {
          setConfirmClearAll(false);
          await clearAll();
        }}
      />
    </div>
  );
}
