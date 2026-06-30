"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./adminApi";
import { Badge, Banner, Button, Card, Select } from "./ui";

type TableInfo = { name: string; rows: number };
type ColumnInfo = { name: string; type: string };
type TablePage = {
  name: string;
  columns: ColumnInfo[];
  rows: (string | null)[][];
  total: number;
  skip: number;
  take: number;
};

const PAGE_SIZES = [25, 50, 100];

export default function DatabaseBrowser() {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selected, setSelected] = useState("");
  const [page, setPage] = useState<TablePage | null>(null);
  const [skip, setSkip] = useState(0);
  const [take, setTake] = useState(50);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Load the table list once on mount; default to the first table.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api("/api/admin/database/tables");
        if (!res.ok) throw new Error(`Failed to load tables (${res.status})`);
        const data: { tables: TableInfo[] } = await res.json();
        if (cancelled) return;
        setTables(data.tables);
        if (data.tables.length > 0) setSelected(data.tables[0].name);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load tables");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load a page whenever the selected table, offset, or page size changes.
  const load = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const res = await api(
        `/api/admin/database/tables/${encodeURIComponent(selected)}?skip=${skip}&take=${take}`,
      );
      if (!res.ok) throw new Error(`Failed to load rows (${res.status})`);
      setPage(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load rows");
      setPage(null);
    } finally {
      setBusy(false);
    }
  }, [selected, skip, take]);

  useEffect(() => {
    void load();
  }, [load]);

  function changeTable(name: string) {
    setSelected(name);
    setSkip(0);
    setPage(null);
  }

  function changePageSize(v: string) {
    setTake(Number(v));
    setSkip(0);
    setPage(null); // avoid showing the previous page's rows against the new range while reloading
  }

  const total = page?.total ?? 0;
  const from = total === 0 ? 0 : skip + 1;
  const to = Math.min(skip + take, total);
  const canPrev = skip > 0;
  const canNext = skip + take < total;

  return (
    <div className="space-y-4">
      <Card
        title="Database"
        subtitle="Browse every table in the database. Read-only."
        right={<Badge tone="gray">Read-only</Badge>}
      >
        <div className="flex flex-wrap items-end gap-4">
          <label className="block">
            <span className="text-sm font-medium">Table</span>
            <div className="mt-1">
              <Select value={selected} onChange={changeTable} disabled={busy || tables.length === 0}>
                {tables.length === 0 && <option value="">No tables</option>}
                {tables.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name} (~{t.rows.toLocaleString()} rows)
                  </option>
                ))}
              </Select>
            </div>
          </label>
          <label className="block">
            <span className="text-sm font-medium">Rows per page</span>
            <div className="mt-1">
              <Select value={String(take)} onChange={changePageSize} disabled={busy}>
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </div>
          </label>
        </div>
      </Card>

      {error && <Banner kind="error">{error}</Banner>}

      {page && (
        <Card
          title={page.name}
          subtitle={`${page.columns.length} column${page.columns.length === 1 ? "" : "s"}`}
          right={<span className="text-sm text-black/55 dark:text-white/55">{total.toLocaleString()} rows</span>}
        >
          <div className="overflow-x-auto rounded-lg border border-black/10 dark:border-white/10">
            <table className="w-full border-collapse text-left text-sm">
              <thead className="bg-black/5 dark:bg-white/5">
                <tr>
                  {page.columns.map((c) => (
                    <th key={c.name} className="whitespace-nowrap px-3 py-2 align-bottom font-medium">
                      <span className="block">{c.name}</span>
                      <span className="block text-xs font-normal text-black/45 dark:text-white/45">{c.type}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={Math.max(1, page.columns.length)}
                      className="px-3 py-8 text-center text-black/55 dark:text-white/55"
                    >
                      No rows
                    </td>
                  </tr>
                )}
                {page.rows.map((row, ri) => (
                  <tr key={ri} className="border-t border-black/5 dark:border-white/5">
                    {row.map((cell, ci) => (
                      <td
                        key={ci}
                        className="max-w-xs truncate px-3 py-2 font-mono text-xs"
                        title={cell ?? "NULL"}
                      >
                        {cell === null ? (
                          <span className="text-black/35 italic dark:text-white/35">NULL</span>
                        ) : (
                          cell
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="text-sm text-black/55 dark:text-white/55">
              {total === 0
                ? "No rows"
                : `Showing ${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || !canPrev}
                onClick={() => setSkip(Math.max(0, skip - take))}
              >
                Previous
              </Button>
              <Button variant="ghost" size="sm" disabled={busy || !canNext} onClick={() => setSkip(skip + take)}>
                Next
              </Button>
            </div>
          </div>
        </Card>
      )}

      {!page && !error && (
        <Card>
          <p className="text-sm text-black/55 dark:text-white/55">Loading…</p>
        </Card>
      )}
    </div>
  );
}
