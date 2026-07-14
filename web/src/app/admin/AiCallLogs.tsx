"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./adminApi";
import { Badge, Banner, Button, Card, Select } from "./ui";
import { Activity, AlertTriangle, ChevronDown, ChevronRight, Coins, Repeat, Search, Server, X } from "lucide-react";

type AiCallLogDto = {
  id: number;
  createdAt: string;
  provider: string;
  area: string;
  model: string | null;
  keyHint: string | null;
  attempts: number;
  outcome: string;
  errorKind: string | null;
  errorMessage: string | null;
  httpStatus: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  durationMs: number | null;
  endUserId: number | null;
  detail: string | null;
};

type AiCallLogsPage = {
  items: AiCallLogDto[];
  total: number;
  skip: number;
  take: number;
};

type StatBucket = { key: string; calls: number; tokens: number };

type AiCallLogStats = {
  hours: number;
  totalCalls: number;
  failedCalls: number;
  totalTokens: number;
  byProvider: StatBucket[];
  byArea: StatBucket[];
  byModel: StatBucket[];
};

const TAKE = 50;

const PROVIDERS = ["gemini", "openrouter", "openai"];
const AREAS = ["admin-chat", "webapp-chat", "tts", "voice-sample", "live-token", "embed", "models", "usage"];
const OUTCOMES = ["ok", "failed"];

// gemini=blue, openrouter=amber, openai=green, anything else falls back to gray.
function providerTone(provider: string): "blue" | "amber" | "green" | "gray" {
  if (provider === "gemini") return "blue";
  if (provider === "openrouter") return "amber";
  if (provider === "openai") return "green";
  return "gray";
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export default function AiCallLogs() {
  const [stats, setStats] = useState<AiCallLogStats | null>(null);

  const [q, setQ] = useState("");
  const [appliedQ, setAppliedQ] = useState("");
  const [provider, setProvider] = useState("");
  const [area, setArea] = useState("");
  const [outcome, setOutcome] = useState("");
  const [skip, setSkip] = useState(0);
  const [page, setPage] = useState<AiCallLogsPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);

  // Header rollup: fetched once on mount for the last 24h.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await api("/api/admin/ai-logs/stats?hours=24");
        if (!res.ok) return;
        const data = (await res.json()) as AiCallLogStats;
        if (alive) setStats(data);
      } catch {
        // Tiles are best-effort; the table below is the source of truth.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ skip: String(skip), take: String(TAKE) });
      if (appliedQ) params.set("q", appliedQ);
      if (provider) params.set("provider", provider);
      if (area) params.set("area", area);
      if (outcome) params.set("outcome", outcome);
      const res = await api(`/api/admin/ai-logs?${params}`);
      if (!res.ok) throw new Error(`Failed to load AI call logs (${res.status})`);
      setPage(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load AI call logs");
      setPage(null);
    } finally {
      setBusy(false);
    }
  }, [appliedQ, provider, area, outcome, skip]);

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

  // Selects apply immediately; reset paging and any open row.
  function applyFilter(setter: (v: string) => void, value: string) {
    setter(value);
    setSkip(0);
    setExpanded(null);
  }

  const total = page?.total ?? 0;
  const from = total === 0 ? 0 : skip + 1;
  const to = Math.min(skip + TAKE, total);
  const canPrev = skip > 0;
  const canNext = skip + TAKE < total;

  return (
    <div className="space-y-4">
      {/* Header rollup tiles */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Calls (24h)" icon={<Activity size={16} aria-hidden="true" />}>
          <span className="text-2xl font-semibold tabular-nums">{(stats?.totalCalls ?? 0).toLocaleString()}</span>
        </Tile>
        <Tile label="Tokens (24h)" icon={<Coins size={16} aria-hidden="true" />}>
          <span className="text-2xl font-semibold tabular-nums">{(stats?.totalTokens ?? 0).toLocaleString()}</span>
        </Tile>
        <Tile label="Failures (24h)" icon={<AlertTriangle size={16} aria-hidden="true" />}>
          <span
            className={`text-2xl font-semibold tabular-nums ${
              (stats?.failedCalls ?? 0) > 0 ? "text-red-600 dark:text-red-400" : ""
            }`}
          >
            {(stats?.failedCalls ?? 0).toLocaleString()}
          </span>
        </Tile>
        <Tile label="By provider (24h)" icon={<Server size={16} aria-hidden="true" />}>
          {stats && stats.byProvider.length > 0 ? (
            <ul className="mt-0.5 space-y-1">
              {stats.byProvider.slice(0, 4).map((b) => (
                <li key={b.key} className="flex items-center justify-between gap-2 text-xs">
                  <Badge tone={providerTone(b.key)}>{b.key}</Badge>
                  <span className="tabular-nums text-black/60 dark:text-white/60">{b.calls.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-sm text-black/45 dark:text-white/45">No calls yet</span>
          )}
        </Tile>
      </div>

      <Card
        title="AI Call Logs"
        subtitle="Per-call records of every AI API call — which pooled key handled it, the model, tokens, and outcome. Kept for 30 days."
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
              placeholder="Search by model, key, or error…"
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
          <Select value={provider} onChange={(v) => applyFilter(setProvider, v)}>
            <option value="">All providers</option>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
          <Select value={area} onChange={(v) => applyFilter(setArea, v)}>
            <option value="">All areas</option>
            {AREAS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
          <Select value={outcome} onChange={(v) => applyFilter(setOutcome, v)}>
            <option value="">All outcomes</option>
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
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
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">Provider</th>
                <th className="px-3 py-2 font-medium">Area</th>
                <th className="px-3 py-2 font-medium">Model</th>
                <th className="px-3 py-2 font-medium">Key</th>
                <th className="px-3 py-2 text-right font-medium">Tokens</th>
                <th className="px-3 py-2 text-right font-medium">Duration</th>
                <th className="px-3 py-2 font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {(!page || page.items.length === 0) && (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-black/45 dark:text-white/45">
                    {busy
                      ? "Loading…"
                      : appliedQ || provider || area || outcome
                        ? "No calls match these filters."
                        : "No AI call logs."}
                  </td>
                </tr>
              )}
              {page?.items.map((r) => {
                const open = expanded === r.id;
                return (
                  <LogRow key={r.id} log={r} open={open} onToggle={() => setExpanded(open ? null : r.id)} />
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs text-black/55 dark:text-white/55">
            {total === 0 ? "0 calls" : `${from}–${to} of ${total}`}
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

function Tile({ label, icon, children }: { label: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-black/10 bg-white/60 p-4 dark:border-white/10 dark:bg-white/3">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-black/55 dark:text-white/55">
        {icon}
        {label}
      </div>
      {children}
    </div>
  );
}

type ChainStep = { hint?: string; error?: string };

// The failover chain (`detail`) is a JSON array of {hint, error?}. Returns the parsed steps, or `null` when
// the string isn't parseable / isn't an array so the caller can fall back to showing it raw.
function parseChain(detail: string): ChainStep[] | null {
  try {
    const parsed = JSON.parse(detail);
    return Array.isArray(parsed) ? (parsed as ChainStep[]) : null;
  } catch {
    return null;
  }
}

function LogRow({ log: r, open, onToggle }: { log: AiCallLogDto; open: boolean; onToggle: () => void }) {
  const chain = r.detail ? parseChain(r.detail) : null;
  const tokenTitle =
    r.promptTokens != null || r.completionTokens != null
      ? `Prompt ${r.promptTokens ?? "—"} · Completion ${r.completionTokens ?? "—"}`
      : undefined;

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
        <td className="px-3 py-2 text-xs whitespace-nowrap text-black/70 dark:text-white/70">
          {new Date(r.createdAt).toLocaleString()}
        </td>
        <td className="px-3 py-2">
          <Badge tone={providerTone(r.provider)}>{r.provider}</Badge>
        </td>
        <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{r.area || "—"}</td>
        <td className="max-w-[16rem] truncate px-3 py-2 text-xs" title={r.model ?? undefined}>
          {r.model || "—"}
        </td>
        <td className="px-3 py-2 font-mono text-xs whitespace-nowrap text-black/70 dark:text-white/70">
          {r.keyHint || "—"}
        </td>
        <td className="px-3 py-2 text-right text-xs tabular-nums whitespace-nowrap" title={tokenTitle}>
          {r.totalTokens != null ? r.totalTokens.toLocaleString() : "—"}
        </td>
        <td className="px-3 py-2 text-right text-xs tabular-nums whitespace-nowrap text-black/70 dark:text-white/70">
          {fmtDuration(r.durationMs)}
        </td>
        <td className="px-3 py-2">
          <span className="inline-flex items-center gap-1.5">
            <Badge tone={r.outcome === "failed" ? "red" : "green"}>{r.outcome}</Badge>
            {r.attempts > 1 && (
              <span
                className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                title={`Failed over across ${r.attempts} keys`}
              >
                <Repeat size={11} aria-hidden="true" />×{r.attempts}
              </span>
            )}
          </span>
        </td>
      </tr>
      {open && (
        <tr className="border-t border-black/5 bg-black/2 dark:border-white/5 dark:bg-white/2">
          <td colSpan={9} className="px-4 py-3">
            <div className="space-y-3 text-xs">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
                <Kv label="Provider">{r.provider}</Kv>
                <Kv label="Area">{r.area || "—"}</Kv>
                <Kv label="Model" mono>
                  {r.model || "—"}
                </Kv>
                <Kv label="Key" mono>
                  {r.keyHint || "—"}
                </Kv>
                <Kv label="Attempts">{r.attempts}</Kv>
                <Kv label="HTTP status">{r.httpStatus ?? "—"}</Kv>
                <Kv label="End user">{r.endUserId ?? "—"}</Kv>
                <Kv label="Duration">{fmtDuration(r.durationMs)}</Kv>
                <Kv label="Prompt tokens">{r.promptTokens != null ? r.promptTokens.toLocaleString() : "—"}</Kv>
                <Kv label="Completion tokens">
                  {r.completionTokens != null ? r.completionTokens.toLocaleString() : "—"}
                </Kv>
                <Kv label="Total tokens">{r.totalTokens != null ? r.totalTokens.toLocaleString() : "—"}</Kv>
              </dl>

              {r.outcome === "failed" && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-black/55 dark:text-white/55">Error</span>
                    {r.errorKind && <Badge tone="red">{r.errorKind}</Badge>}
                  </div>
                  {r.errorMessage && (
                    <pre className="max-h-60 overflow-auto rounded-md border border-black/10 bg-white/60 p-3 font-mono whitespace-pre-wrap dark:border-white/10 dark:bg-black/30">
                      {r.errorMessage}
                    </pre>
                  )}
                </div>
              )}

              {r.detail && (
                <div>
                  <span className="mb-1 block font-medium text-black/55 dark:text-white/55">Failover chain</span>
                  {chain ? (
                    <ol className="space-y-1">
                      {chain.map((step, i) => (
                        <li key={i} className="flex gap-2">
                          <span className="text-black/40 tabular-nums dark:text-white/40">{i + 1}.</span>
                          <span className="font-mono">{step.hint || "—"}</span>
                          <span className="text-black/45 dark:text-white/45">— {step.error || "ok"}</span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <pre className="max-h-60 overflow-auto rounded-md border border-black/10 bg-white/60 p-3 font-mono whitespace-pre-wrap dark:border-white/10 dark:bg-black/30">
                      {r.detail}
                    </pre>
                  )}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Kv({ label, children, mono = false }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="mb-0.5 text-black/45 dark:text-white/45">{label}</dt>
      <dd className={`truncate ${mono ? "font-mono" : ""}`}>{children}</dd>
    </div>
  );
}
