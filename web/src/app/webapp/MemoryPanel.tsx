"use client";

import { useState } from "react";
import { Loader2, Search, Trash2, Volume2, X } from "lucide-react";
import { embedQuery } from "./lib/embed";
import { clearAllMemories, deleteMemory, type MemoryHit, searchMemories } from "./recordApi";

export default function MemoryPanel({
  open,
  onClose,
  memoryOn,
  onToggleMemory,
}: {
  open: boolean;
  onClose: () => void;
  memoryOn: boolean;
  onToggleMemory: (on: boolean) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<MemoryHit[] | null>(null);
  const [busy, setBusy] = useState(false);

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
          <h2 className="font-semibold">Your memories</h2>
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-black/5 dark:hover:bg-white/10" aria-label="Close">
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
          <label className="flex items-center justify-between gap-2 rounded-lg bg-black/3 px-3 py-2 text-sm dark:bg-white/5">
            <span>
              <span className="font-medium">Remember my chats</span>
              <span className="mt-0.5 block text-xs text-black/55 dark:text-white/55">
                Saves your chats so you (and the AI) can recall them. You can clear them any time.
              </span>
            </span>
            <input
              type="checkbox"
              checked={memoryOn}
              onChange={(e) => onToggleMemory(e.target.checked)}
              className="h-5 w-5 shrink-0"
            />
          </label>

          <div className="flex items-center gap-2">
            <div className="flex flex-1 items-center gap-2 rounded-lg border border-black/15 px-3 py-2 dark:border-white/20">
              <Search size={16} className="text-black/40 dark:text-white/40" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && run()}
                placeholder="Search your past chats…"
                className="flex-1 bg-transparent text-sm outline-none"
              />
            </div>
            <button
              onClick={run}
              disabled={busy}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : "Search"}
            </button>
          </div>

          {hits && hits.length === 0 && (
            <p className="text-sm text-black/50 dark:text-white/50">No matching memories yet.</p>
          )}

          <ul className="space-y-2">
            {hits?.map((h) => (
              <li
                key={h.id}
                className="rounded-lg border border-black/10 px-3 py-2.5 text-sm dark:border-white/10"
              >
                <div className="mb-1 flex items-center gap-2 text-xs text-black/45 dark:text-white/45">
                  <span className="rounded-full bg-black/10 px-2 py-0.5 dark:bg-white/10">
                    {h.role === "assistant" ? "AI" : "You"}
                  </span>
                  <span>{new Date(h.createdAt).toLocaleString()}</span>
                  <span className="ml-auto flex items-center gap-1">
                    {h.hasAudio && (
                      <button onClick={() => play(h.id)} className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/10" aria-label="Play audio">
                        <Volume2 size={14} />
                      </button>
                    )}
                    <button onClick={() => remove(h.id)} className="rounded p-1 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40" aria-label="Delete">
                      <Trash2 size={14} />
                    </button>
                  </span>
                </div>
                <p className="whitespace-pre-wrap break-words">{h.content}</p>
              </li>
            ))}
          </ul>

          {hits && hits.length > 0 && (
            <button onClick={clearAll} className="text-xs text-red-600 hover:underline dark:text-red-400">
              Clear all memories
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}
