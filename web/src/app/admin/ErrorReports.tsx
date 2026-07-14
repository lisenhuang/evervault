"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./adminApi";
import { Badge, Banner, Button, Card } from "./ui";
import { ChevronDown, ChevronRight, Search, X } from "lucide-react";

type ErrorReportDto = {
  id: number;
  code: string;
  source: string; // backend | client
  area: string;
  endUserId: number | null;
  httpStatus: number | null;
  message: string;
  detail: string | null;
  userAgent: string | null;
  createdAt: string;
};

type ErrorReportsPage = {
  items: ErrorReportDto[];
  total: number;
  skip: number;
  take: number;
};

const TAKE = 50;

export default function ErrorReports() {
  const [q, setQ] = useState("");
  const [appliedQ, setAppliedQ] = useState("");
  const [skip, setSkip] = useState(0);
  const [page, setPage] = useState<ErrorReportsPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ skip: String(skip), take: String(TAKE) });
      if (appliedQ) params.set("q", appliedQ);
      const res = await api(`/api/admin/errors?${params}`);
      if (!res.ok) throw new Error(`Failed to load error reports (${res.status})`);
      setPage(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load error reports");
      setPage(null);
    } finally {
      setBusy(false);
    }
  }, [appliedQ, skip]);

  useEffect(() => {
    void load();
  }, [load]);

  function search() {
    setSkip(0);
    setExpanded(null);
    setAppliedQ(q.trim());
  }

  function clearSearch() {
    setQ("");
    setSkip(0);
    setExpanded(null);
    setAppliedQ("");
  }

  const total = page?.total ?? 0;
  const from = total === 0 ? 0 : skip + 1;
  const to = Math.min(skip + TAKE, total);
  const canPrev = skip > 0;
  const canNext = skip + TAKE < total;

  return (
    <div className="space-y-4">
      <Card
        title="Error Reports"
        subtitle="Look up the reference code a user sees on a failed request (e.g. EV-7K2M9QX4) to view the full detail that was never shown to them. Reports are kept for 30 days."
      >
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
        >
          <div className="relative min-w-0 flex-1 basis-64">
            <Search
              size={16}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-black/40 dark:text-white/40"
              aria-hidden="true"
            />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by code, area, or message…"
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
          </div>
          <Button type="submit" disabled={busy}>
            Search
          </Button>
        </form>

        {error && (
          <div className="mt-4">
            <Banner kind="error">{error}</Banner>
          </div>
        )}

        <div className="mt-4 overflow-x-auto rounded-lg border border-black/10 dark:border-white/10">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-black/5 dark:bg-white/5">
              <tr>
                <th className="w-8 px-2 py-2" aria-label="Expand" />
                <th className="px-3 py-2 font-medium">Code</th>
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Area</th>
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Message</th>
              </tr>
            </thead>
            <tbody>
              {(!page || page.items.length === 0) && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-black/45 dark:text-white/45">
                    {busy ? "Loading…" : appliedQ ? "No reports match this search." : "No error reports."}
                  </td>
                </tr>
              )}
              {page?.items.map((r) => {
                const open = expanded === r.id;
                return (
                  <ReportRow
                    key={r.id}
                    report={r}
                    open={open}
                    onToggle={() => setExpanded(open ? null : r.id)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs text-black/55 dark:text-white/55">
            {total === 0 ? "0 reports" : `${from}–${to} of ${total}`}
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
    </div>
  );
}

function ReportRow({ report: r, open, onToggle }: { report: ErrorReportDto; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr
        className="cursor-pointer border-t border-black/5 transition hover:bg-black/2 focus-visible:bg-black/5 focus-visible:outline-none dark:border-white/5 dark:hover:bg-white/2 dark:focus-visible:bg-white/5"
        onClick={onToggle}
        tabIndex={0}
        role="button"
        aria-expanded={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <td className="px-2 py-2 text-black/40 dark:text-white/40">
          {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        </td>
        <td className="px-3 py-2 font-mono text-xs font-semibold whitespace-nowrap">{r.code}</td>
        <td className="px-3 py-2 text-xs whitespace-nowrap text-black/70 dark:text-white/70">
          {new Date(r.createdAt).toLocaleString()}
        </td>
        <td className="px-3 py-2">
          <Badge tone={r.source === "client" ? "amber" : "blue"}>{r.source}</Badge>
        </td>
        <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{r.area || "—"}</td>
        <td className="px-3 py-2 text-xs">{r.endUserId ?? "—"}</td>
        <td className="px-3 py-2 text-xs">{r.httpStatus ?? "—"}</td>
        <td className="max-w-md truncate px-3 py-2 text-xs" title={r.message}>
          {r.message || "—"}
        </td>
      </tr>
      {open && (
        <tr className="border-t border-black/5 bg-black/2 dark:border-white/5 dark:bg-white/2">
          <td colSpan={8} className="px-4 py-3">
            <div className="space-y-3 text-xs">
              <div>
                <span className="mb-1 block font-medium text-black/55 dark:text-white/55">Message</span>
                <p className="whitespace-pre-wrap">{r.message || "—"}</p>
              </div>
              <div>
                <span className="mb-1 block font-medium text-black/55 dark:text-white/55">Detail</span>
                <pre className="max-h-80 overflow-auto rounded-md border border-black/10 bg-white/60 p-3 font-mono whitespace-pre-wrap dark:border-white/10 dark:bg-black/30">
                  {r.detail || "—"}
                </pre>
              </div>
              {r.userAgent && (
                <div>
                  <span className="mb-1 block font-medium text-black/55 dark:text-white/55">User agent</span>
                  <p className="font-mono break-all">{r.userAgent}</p>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
