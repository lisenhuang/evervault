"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./adminApi";
import StorageForm from "./StorageForm";
import { Banner, Button, Card } from "./ui";

type Tab = "memories" | "storage";

export default function Dashboard({ email, onLogout }: { email: string; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>("memories");

  async function logout() {
    await api("/api/admin/logout", { method: "POST" });
    onLogout();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-black/60 dark:text-white/60">
          Signed in as <strong>{email}</strong>
        </p>
        <Button variant="ghost" onClick={logout}>
          Log out
        </Button>
      </div>

      <div className="flex gap-2">
        <Button variant={tab === "memories" ? "primary" : "ghost"} onClick={() => setTab("memories")}>
          Memories
        </Button>
        <Button variant={tab === "storage" ? "primary" : "ghost"} onClick={() => setTab("storage")}>
          Storage
        </Button>
      </div>

      {tab === "memories" ? <MemoriesPanel /> : <StorageForm />}
    </div>
  );
}

type Memory = { id: number; content: string; createdAt: string };
type Hit = { id: number; content: string; distance: number };

function MemoriesPanel() {
  const [items, setItems] = useState<Memory[]>([]);
  const [content, setContent] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const res = await api("/api/memories");
    if (res.ok) setItems(await res.json());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    setError("");
    if (!content.trim()) return;
    const res = await api("/api/memories", { method: "POST", body: JSON.stringify({ content }) });
    if (res.ok) {
      setContent("");
      setHits(null);
      void load();
    } else {
      setError("Could not add memory — are you still signed in?");
    }
  }

  async function del(id: number) {
    await api(`/api/memories/${id}`, { method: "DELETE" });
    void load();
  }

  async function search() {
    if (!query.trim()) {
      setHits(null);
      return;
    }
    const res = await api(`/api/memories/search?q=${encodeURIComponent(query)}&k=5`);
    if (res.ok) setHits(await res.json());
  }

  const inputCls =
    "flex-1 rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-white/20";

  return (
    <Card title="Memories">
      <div className="space-y-4">
        <div className="flex gap-2">
          <input
            className={inputCls}
            placeholder="Add a memory…"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <Button onClick={add}>Add</Button>
        </div>
        {error && <Banner kind="error">{error}</Banner>}

        <div className="flex gap-2">
          <input
            className={inputCls}
            placeholder="Semantic search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
          />
          <Button variant="ghost" onClick={search}>
            Search
          </Button>
        </div>

        {hits ? (
          <ul className="space-y-1 text-sm">
            <li className="text-xs uppercase tracking-wide text-black/50 dark:text-white/50">Top matches</li>
            {hits.map((h) => (
              <li key={h.id} className="flex justify-between rounded-md bg-black/5 px-3 py-2 dark:bg-white/5">
                <span>{h.content}</span>
                <span className="text-black/40 dark:text-white/40">{h.distance.toFixed(3)}</span>
              </li>
            ))}
            {hits.length === 0 && <li className="text-black/50">No matches.</li>}
          </ul>
        ) : (
          <ul className="space-y-1 text-sm">
            {items.map((m) => (
              <li key={m.id} className="flex items-center justify-between rounded-md bg-black/5 px-3 py-2 dark:bg-white/5">
                <span>{m.content}</span>
                <Button variant="danger" onClick={() => del(m.id)}>
                  Delete
                </Button>
              </li>
            ))}
            {items.length === 0 && <li className="text-black/50">No memories yet.</li>}
          </ul>
        )}
      </div>
    </Card>
  );
}
