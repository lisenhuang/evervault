"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { api } from "./adminApi";
import { Badge, Banner, Button, Card, Field } from "./ui";

type Dto = {
  apiKeyConfigured: boolean;
  keyHint: string | null;
  updatedAt: string;
};

export default function WebSearchForm() {
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [keyHint, setKeyHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await api("/api/admin/search/brave");
      if (res.ok && res.status !== 204) {
        const d: Dto = await res.json();
        setConfigured(d.apiKeyConfigured);
        setKeyHint(d.keyHint);
      }
    })();
  }, []);

  async function save() {
    setBusy(true);
    setMsg(null);
    const res = await api("/api/admin/search/brave", {
      method: "PUT",
      body: JSON.stringify({ apiKey: apiKey || null }),
    });
    setBusy(false);
    if (res.ok) {
      const d: Dto = await res.json();
      setApiKey("");
      setConfigured(d.apiKeyConfigured);
      setKeyHint(d.keyHint);
      setMsg({ kind: "success", text: "Saved." });
    } else {
      const d = await res.json().catch(() => ({}));
      setMsg({ kind: "error", text: d.error ?? "Could not save the key." });
    }
  }

  return (
    <div className="space-y-6">
      <Card
        title="Web Search"
        subtitle="Lets the assistant look things up on the live web (current events, prices, facts that change). Turned on simply by storing a key here."
        right={
          configured ? (
            <Badge tone="green">
              <Check size={12} aria-hidden="true" /> Configured
            </Badge>
          ) : (
            <Badge tone="gray">Not configured</Badge>
          )
        }
      >
        <div className="space-y-4">
          <Field
            label={configured ? "Brave Search API key (configured — leave blank to keep)" : "Brave Search API key"}
            type="password"
            value={apiKey}
            onChange={setApiKey}
            placeholder={configured ? "••••••••" : ""}
            help={
              <>
                Get a free key at <code>api-dashboard.search.brave.com</code> → Subscriptions → API Keys. Stored
                encrypted; never shown again.
              </>
            }
          />
          {configured && keyHint && (
            <p className="text-xs text-black/55 dark:text-white/55">
              Current key: <code>{keyHint}</code>
            </p>
          )}
          {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
          <Button onClick={save} disabled={busy || (!configured && !apiKey.trim())}>
            Save
          </Button>
        </div>
      </Card>

      <Card title="How it works">
        <ul className="list-disc space-y-2 pl-5 text-sm text-black/70 dark:text-white/70">
          <li>
            With a key saved, the /webapp assistant can search the web mid-reply when a question needs current or
            fast-changing information, and answer from what it finds.
          </li>
          <li>
            <strong>Fallback:</strong> the free Brave plan allows about one query per second, which a burst of
            questions trips easily. When a search is rate-limited or fails, it automatically falls back to your
            existing Gemini keys, so search keeps working without a paid plan.
          </li>
          <li>
            The fallback only runs on classic <code>AIzaSy…</code> Gemini keys — newer <code>AQ.…</code> keys are
            skipped, since they land in projects with no search quota.
          </li>
          <li>
            With no key here and no eligible Gemini key, the assistant simply tells users it can’t look things up
            right now — it never mentions a key or any setup detail.
          </li>
          <li>Keys stay on the server and are never sent to the browser; only a “configured” flag is exposed.</li>
        </ul>
      </Card>
    </div>
  );
}
