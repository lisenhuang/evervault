"use client";

import { useEffect, useState } from "react";
import { Check, Circle, Loader2, X } from "lucide-react";
import { api } from "./adminApi";
import { Banner, Button, Card, Field } from "./ui";

type Dto = {
  accountId: string;
  accessKeyId: string;
  bucket: string;
  endpoint: string | null;
  region: string;
  publicBaseUrl: string | null;
  jurisdiction: string | null;
  secretConfigured: boolean;
  updatedAt: string;
};

type SampleStatus = "idle" | "generating" | "generated" | "failed";
type VoiceStat = { name: string; status: SampleStatus; error?: string };

function VoiceIcon({ status }: { status: SampleStatus }) {
  if (status === "generating")
    return <Loader2 size={14} className="shrink-0 animate-spin text-blue-600 dark:text-blue-400" aria-hidden="true" />;
  if (status === "generated")
    return <Check size={14} className="shrink-0 text-green-600 dark:text-green-400" aria-hidden="true" />;
  if (status === "failed")
    return <X size={14} className="shrink-0 text-red-600 dark:text-red-400" aria-hidden="true" />;
  return <Circle size={8} className="shrink-0 text-black/25 dark:text-white/25" aria-hidden="true" />;
}

export default function StorageForm() {
  const [accountId, setAccountId] = useState("");
  const [bucket, setBucket] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [publicBaseUrl, setPublicBaseUrl] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [secretConfigured, setSecretConfigured] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [samplesMsg, setSamplesMsg] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [samplesLoading, setSamplesLoading] = useState(true);
  const [voices, setVoices] = useState<VoiceStat[]>([]);

  useEffect(() => {
    void (async () => {
      const res = await api("/api/admin/storage");
      if (res.ok) {
        const d: Dto = await res.json();
        setAccountId(d.accountId);
        setBucket(d.bucket);
        setAccessKeyId(d.accessKeyId);
        setEndpoint(d.endpoint ?? "");
        setPublicBaseUrl(d.publicBaseUrl ?? "");
        setJurisdiction(d.jurisdiction ?? "");
        setSecretConfigured(d.secretConfigured);
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      const res = await api("/api/admin/storage/samples");
      if (res.ok) {
        const d: { model: string; voices: { name: string; generated: boolean }[] } = await res.json();
        setVoices(d.voices.map((v): VoiceStat => ({ name: v.name, status: v.generated ? "generated" : "idle" })));
      }
      setSamplesLoading(false);
    })();
  }, []);

  function body() {
    return JSON.stringify({
      accountId,
      accessKeyId,
      secret: secret || null,
      bucket,
      endpoint: endpoint || null,
      region: "auto",
      publicBaseUrl: publicBaseUrl || null,
      jurisdiction: jurisdiction || null,
    });
  }

  async function test() {
    setBusy(true);
    setMsg(null);
    const res = await api("/api/admin/storage/test", { method: "POST", body: body() });
    const r = await res.json();
    setBusy(false);
    setMsg({ kind: r.ok ? "success" : "error", text: r.message });
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    const res = await api("/api/admin/storage", { method: "PUT", body: body() });
    setBusy(false);
    if (res.ok) {
      setSecret("");
      setSecretConfigured(true);
      setMsg({ kind: "success", text: "Saved." });
    } else {
      setMsg({ kind: "error", text: "Could not save the configuration." });
    }
  }

  // Generates one voice at a time so each row updates live. `force` regenerates existing ones too.
  async function generate(force: boolean) {
    setGenerating(true);
    setSamplesMsg(null);
    const targets = voices.filter((v) => force || v.status !== "generated").map((v) => v.name);
    let ok = 0;
    let failed = 0;

    for (const name of targets) {
      setVoices((cur) => cur.map((v) => (v.name === name ? { ...v, status: "generating", error: undefined } : v)));
      try {
        const res = await api(
          `/api/admin/storage/samples/${encodeURIComponent(name)}${force ? "?force=true" : ""}`,
          { method: "POST" },
        );
        if (res.ok) {
          ok++;
          setVoices((cur) => cur.map((v) => (v.name === name ? { ...v, status: "generated" } : v)));
        } else {
          failed++;
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          setVoices((cur) => cur.map((v) => (v.name === name ? { ...v, status: "failed", error: d.error } : v)));
        }
      } catch {
        failed++;
        setVoices((cur) => cur.map((v) => (v.name === name ? { ...v, status: "failed", error: "Network error." } : v)));
      }
    }

    setGenerating(false);
    setSamplesMsg({
      kind: failed > 0 ? "error" : "success",
      text: `Done — ${ok} generated${failed > 0 ? `, ${failed} failed (hover a red row for the reason)` : ""}.`,
    });
  }

  return (
    <>
    <Card title="Storage — Cloudflare R2 (S3-compatible)">
      <p className="mb-4 text-sm text-black/60 dark:text-white/60">
        Configure object storage here — no server access or <code>.env</code> needed. The secret is
        encrypted before it’s stored.
      </p>
      <div className="space-y-4">
        <Field
          label="Account ID"
          value={accountId}
          onChange={setAccountId}
          required
          help="Cloudflare dashboard → R2 → Overview (also inside the S3 endpoint https://<ACCOUNT_ID>.r2.cloudflarestorage.com)."
        />
        <Field
          label="Bucket name"
          value={bucket}
          onChange={setBucket}
          required
          help="R2 → Create bucket (or an existing bucket’s name)."
        />
        <Field
          label="Access Key ID"
          value={accessKeyId}
          onChange={setAccessKeyId}
          required
          help="R2 → Manage R2 API Tokens → Create API token (permission: Object Read & Write)."
        />
        <Field
          label={secretConfigured ? "Secret Access Key (configured — leave blank to keep)" : "Secret Access Key"}
          type="password"
          value={secret}
          onChange={setSecret}
          required={!secretConfigured}
          placeholder={secretConfigured ? "••••••••" : ""}
          help="Shown only once on the same token screen. If lost, create a new token."
        />
        <Field
          label="S3 Endpoint (optional)"
          value={endpoint}
          onChange={setEndpoint}
          help="Leave blank to auto-derive from Account ID. Override only for the EU jurisdiction."
        />
        <Field
          label="Public base URL (optional)"
          value={publicBaseUrl}
          onChange={setPublicBaseUrl}
          help="R2 → bucket → Settings → Public access (the …r2.dev subdomain or a custom domain)."
        />
        <Field
          label="Jurisdiction (optional)"
          value={jurisdiction}
          onChange={setJurisdiction}
          help="Leave blank for the default jurisdiction, or enter “eu” for the EU jurisdiction."
        />
        {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
        <div className="flex gap-2">
          <Button variant="ghost" onClick={test} disabled={busy}>
            Test connection
          </Button>
          <Button onClick={save} disabled={busy}>
            Save
          </Button>
        </div>
      </div>
    </Card>

    <Card title="Voice preview samples">
      <p className="mb-4 text-sm text-black/60 dark:text-white/60">
        Pre-generate the 30 prebuilt voice samples and store them in R2 so the chat “Preview voice”
        button plays instantly. They’re synthesized with the server Gemini keys (failing over to the
        next key if one fails). Requires storage and at least one Gemini key to be configured.
      </p>

      {!secretConfigured && (
        <div className="mb-4">
          <Banner kind="info">Configure and save your R2 storage above before generating samples.</Banner>
        </div>
      )}

      {samplesLoading ? (
        <p className="text-sm text-black/50 dark:text-white/50">Loading…</p>
      ) : (
        <>
          {(() => {
            const generatedCount = voices.filter((v) => v.status === "generated").length;
            const pct = voices.length ? (generatedCount / voices.length) * 100 : 0;
            const missing = voices.some((v) => v.status !== "generated");
            return (
              <>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="font-medium">
                    {generatedCount} / {voices.length} generated
                  </span>
                </div>
                <div className="mb-4 h-2 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                  <div
                    className="h-full rounded-full bg-blue-600 transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>

                <ul className="mb-4 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
                  {voices.map((v) => (
                    <li key={v.name} className="flex items-center gap-1.5 text-sm" title={v.error}>
                      <VoiceIcon status={v.status} />
                      <span className={v.status === "failed" ? "text-red-600 dark:text-red-400" : ""}>
                        {v.name}
                      </span>
                    </li>
                  ))}
                </ul>

                {samplesMsg && <Banner kind={samplesMsg.kind}>{samplesMsg.text}</Banner>}

                <div className="mt-4 flex gap-2">
                  <Button onClick={() => generate(false)} disabled={generating || !missing}>
                    {generating ? "Generating…" : missing ? "Generate voice samples" : "All 30 generated"}
                  </Button>
                  <Button variant="ghost" onClick={() => generate(true)} disabled={generating}>
                    Regenerate all
                  </Button>
                </div>
              </>
            );
          })()}
        </>
      )}
    </Card>
    </>
  );
}
