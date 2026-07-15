"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./adminApi";
import { Badge, Banner, Button, Card, Select } from "./ui";
import { Archive, Check, Inbox, Search, X } from "lucide-react";

type SuggestionImageDto = { id: number; mime: string };

type SuggestionDto = {
  id: number;
  endUserId: number | null;
  userEmail: string | null;
  category: string; // feature | bug | praise | complaint | other
  summary: string;
  details: string;
  status: string; // new | reviewed | archived
  userAgent: string | null;
  createdAt: string;
  images: SuggestionImageDto[];
};

type SuggestionsPage = {
  items: SuggestionDto[];
  total: number;
  skip: number;
  take: number;
};

const TAKE = 25;

const CATEGORY_TONE: Record<string, "gray" | "green" | "red" | "blue" | "amber"> = {
  feature: "blue",
  bug: "red",
  praise: "green",
  complaint: "amber",
  other: "gray",
};

const STATUS_TONE: Record<string, "gray" | "green" | "red" | "blue" | "amber"> = {
  new: "blue",
  reviewed: "green",
  archived: "gray",
};

export default function Suggestions() {
  const [q, setQ] = useState("");
  const [appliedQ, setAppliedQ] = useState("");
  const [status, setStatus] = useState("all");
  const [skip, setSkip] = useState(0);
  const [page, setPage] = useState<SuggestionsPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lightbox, setLightbox] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ skip: String(skip), take: String(TAKE) });
      if (appliedQ) params.set("q", appliedQ);
      if (status !== "all") params.set("status", status);
      const res = await api(`/api/admin/suggestions?${params}`);
      if (!res.ok) throw new Error(`Failed to load suggestions (${res.status})`);
      const data: SuggestionsPage = await res.json();
      // If a reload (e.g. after a status change removed the last row of a filtered page) leaves us past
      // the end, step back to the last page that still has rows instead of stranding on an empty one.
      if (data.items.length === 0 && data.total > 0 && skip > 0) {
        setSkip(Math.max(0, Math.floor((data.total - 1) / TAKE) * TAKE));
        return;
      }
      setPage(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load suggestions");
      setPage(null);
    } finally {
      setBusy(false);
    }
  }, [appliedQ, status, skip]);

  useEffect(() => {
    void load();
  }, [load]);

  function search() {
    setSkip(0);
    setAppliedQ(q.trim());
  }

  function clearSearch() {
    setQ("");
    setSkip(0);
    setAppliedQ("");
  }

  // Optimistically flip the status, then persist. Reverts on failure.
  async function setStatusFor(id: number, next: string) {
    setError(""); // drop any stale error from a previous failed action
    const prev = page;
    setPage((p) => (p ? { ...p, items: p.items.map((s) => (s.id === id ? { ...s, status: next } : s)) } : p));
    try {
      const res = await api(`/api/admin/suggestions/${id}`, { method: "PATCH", body: JSON.stringify({ status: next }) });
      if (!res.ok) throw new Error();
      // If a status filter is active, the row may no longer belong here — refresh to reconcile counts.
      if (status !== "all") void load();
    } catch {
      setPage(prev);
      setError("Could not update the status. Please try again.");
    }
  }

  const total = page?.total ?? 0;
  const from = total === 0 ? 0 : skip + 1;
  const to = Math.min(skip + TAKE, total);
  const canPrev = skip > 0;
  const canNext = skip + TAKE < total;

  return (
    <div className="space-y-4">
      <Card
        title="Suggestions"
        subtitle="Product feedback that end users chose to share with the team from the /webapp assistant. Newest first."
      >
        <div className="flex flex-wrap items-center gap-2">
          <form
            className="relative min-w-0 flex-1 basis-64"
            onSubmit={(e) => {
              e.preventDefault();
              search();
            }}
          >
            <Search
              size={16}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-black/40 dark:text-white/40"
              aria-hidden="true"
            />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search summary, details, category, or email…"
              className="w-full rounded-md border border-black/15 bg-transparent py-2 pr-9 pl-9 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-white/20"
            />
            {q && (
              <button
                type="button"
                onClick={clearSearch}
                aria-label="Clear search"
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-black/40 transition hover:bg-black/5 hover:text-black/70 dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white/70"
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </form>
          <Select
            value={status}
            onChange={(v) => {
              setSkip(0);
              setStatus(v);
            }}
          >
            <option value="all">All statuses</option>
            <option value="new">New</option>
            <option value="reviewed">Reviewed</option>
            <option value="archived">Archived</option>
          </Select>
          <Button onClick={search} disabled={busy}>
            Search
          </Button>
        </div>

        {error && (
          <div className="mt-4">
            <Banner kind="error">{error}</Banner>
          </div>
        )}

        <div className="mt-4 space-y-3">
          {(!page || page.items.length === 0) && (
            <p className="rounded-lg border border-black/10 px-3 py-8 text-center text-sm text-black/45 dark:border-white/10 dark:text-white/45">
              {busy ? "Loading…" : appliedQ || status !== "all" ? "No suggestions match this filter." : "No suggestions yet."}
            </p>
          )}
          {page?.items.map((s) => (
            <SuggestionCard key={s.id} s={s} onStatus={setStatusFor} onImage={setLightbox} />
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="text-xs text-black/55 dark:text-white/55">
            {total === 0 ? "0 suggestions" : `${from}–${to} of ${total}`}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" disabled={!canPrev || busy} onClick={() => setSkip(Math.max(0, skip - TAKE))}>
              Previous
            </Button>
            <Button variant="ghost" size="sm" disabled={!canNext || busy} onClick={() => setSkip(skip + TAKE)}>
              Next
            </Button>
          </div>
        </div>
      </Card>

      {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

function SuggestionCard({
  s,
  onStatus,
  onImage,
}: {
  s: SuggestionDto;
  onStatus: (id: number, status: string) => void;
  onImage: (src: string) => void;
}) {
  return (
    <div className="rounded-lg border border-black/10 bg-white/40 p-4 dark:border-white/10 dark:bg-white/2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={CATEGORY_TONE[s.category] ?? "gray"}>{s.category}</Badge>
        <Badge tone={STATUS_TONE[s.status] ?? "gray"}>{s.status}</Badge>
        <span className="ml-auto text-xs whitespace-nowrap text-black/50 dark:text-white/50">
          {new Date(s.createdAt).toLocaleString()}
        </span>
      </div>

      <h3 className="mt-2 font-semibold">{s.summary || "—"}</h3>
      {s.details && s.details !== s.summary && (
        <p className="mt-1 text-sm whitespace-pre-wrap text-black/75 dark:text-white/75">{s.details}</p>
      )}

      {s.images.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {s.images.map((img) => {
            const src = `/api/admin/suggestions/${s.id}/image/${img.id}`;
            return (
              <button
                key={img.id}
                type="button"
                onClick={() => onImage(src)}
                className="group relative h-20 w-20 overflow-hidden rounded-md border border-black/10 transition hover:ring-2 hover:ring-blue-500/40 dark:border-white/10"
                aria-label="View screenshot"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt="Attached screenshot" className="h-full w-full object-cover" loading="lazy" />
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-black/45 dark:text-white/45">
          {s.userEmail ? s.userEmail : s.endUserId != null ? `User #${s.endUserId}` : "Unknown user"}
        </span>
        <div className="ml-auto flex gap-1.5">
          <StatusButton active={s.status === "new"} onClick={() => onStatus(s.id, "new")} icon={<Inbox size={13} aria-hidden="true" />} label="New" />
          <StatusButton
            active={s.status === "reviewed"}
            onClick={() => onStatus(s.id, "reviewed")}
            icon={<Check size={13} aria-hidden="true" />}
            label="Reviewed"
          />
          <StatusButton
            active={s.status === "archived"}
            onClick={() => onStatus(s.id, "archived")}
            icon={<Archive size={13} aria-hidden="true" />}
            label="Archive"
          />
        </div>
      </div>
    </div>
  );
}

function StatusButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition ${
        active
          ? "bg-blue-600 text-white shadow-sm"
          : "border border-black/15 text-black/60 hover:bg-black/5 dark:border-white/20 dark:text-white/60 dark:hover:bg-white/10"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

/** Minimal self-contained image preview; closes on backdrop click or Escape. */
function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-100 flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Screenshot"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute top-4 right-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition hover:bg-white/20"
      >
        <X size={20} aria-hidden="true" />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt="Screenshot"
        onClick={(e) => e.stopPropagation()}
        className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
      />
    </div>
  );
}
