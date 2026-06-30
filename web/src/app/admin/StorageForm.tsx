"use client";

import { useEffect, useState } from "react";
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
  const [samplesBusy, setSamplesBusy] = useState(false);

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

  async function generateSamples() {
    setSamplesBusy(true);
    setSamplesMsg({ kind: "info", text: "Generating all 30 — this can take a few minutes. You can re-run it to finish any that don’t complete." });
    const res = await api("/api/admin/storage/samples/generate", { method: "POST" });
    setSamplesBusy(false);
    if (res.ok) {
      const r: { generated: number; skipped: number; failed: number; errors: string[] } = await res.json();
      const summary = `Generated ${r.generated}, skipped ${r.skipped}, failed ${r.failed}.`;
      setSamplesMsg({
        kind: r.failed > 0 ? "error" : "success",
        text: r.failed > 0 ? `${summary} ${r.errors.slice(0, 3).join(" · ")}` : summary,
      });
    } else {
      const d = await res.json().catch(() => ({}));
      setSamplesMsg({ kind: "error", text: d.error ?? "Could not generate voice samples." });
    }
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
        next key if one fails). Already-generated samples are skipped. Requires storage and at least
        one Gemini key to be configured.
      </p>
      {samplesMsg && <Banner kind={samplesMsg.kind}>{samplesMsg.text}</Banner>}
      <div className="mt-4">
        <Button onClick={generateSamples} disabled={samplesBusy}>
          {samplesBusy ? "Generating…" : "Generate voice samples"}
        </Button>
      </div>
    </Card>
    </>
  );
}
