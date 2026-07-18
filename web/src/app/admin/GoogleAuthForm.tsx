"use client";

import { useCallback, useEffect, useState } from "react";
import GoogleSignInButton from "@/components/GoogleSignInButton";
import { api } from "./adminApi";
import { Badge, Banner, Button, Card, Field } from "./ui";

type Dto = {
  clientId: string;
  secretConfigured: boolean;
  enabled: boolean;
  allowedEmailDomain: string | null;
  updatedAt: string;
};

export default function GoogleAuthForm() {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [allowedEmailDomain, setAllowedEmailDomain] = useState("");
  const [secretConfigured, setSecretConfigured] = useState(false);
  const [savedEnabled, setSavedEnabled] = useState(false);
  const [savedClientId, setSavedClientId] = useState("");
  const [boundEmail, setBoundEmail] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState("");

  const loadMe = useCallback(async () => {
    const res = await api("/api/admin/me");
    if (res.ok) {
      const d = await res.json();
      setBoundEmail(d.googleEmail ?? null);
    }
  }, []);

  useEffect(() => {
    setOrigin(window.location.origin);
    void (async () => {
      const res = await api("/api/admin/auth/google");
      if (res.ok) {
        const d: Dto = await res.json();
        setClientId(d.clientId);
        setEnabled(d.enabled);
        setAllowedEmailDomain(d.allowedEmailDomain ?? "");
        setSecretConfigured(d.secretConfigured);
        setSavedEnabled(d.enabled);
        setSavedClientId(d.clientId);
      }
    })();
    void loadMe();
  }, [loadMe]);

  async function save() {
    setBusy(true);
    setMsg(null);
    const res = await api("/api/admin/auth/google", {
      method: "PUT",
      body: JSON.stringify({
        clientId,
        clientSecret: clientSecret || null,
        enabled,
        allowedEmailDomain: allowedEmailDomain || null,
      }),
    });
    setBusy(false);
    if (res.ok) {
      const d: Dto = await res.json();
      setClientSecret("");
      setSecretConfigured(d.secretConfigured);
      setSavedEnabled(d.enabled);
      setSavedClientId(d.clientId);
      setMsg({ kind: "success", text: "Saved." });
    } else {
      setMsg({ kind: "error", text: "Could not save the configuration." });
    }
  }

  async function bind(idToken: string) {
    setBusy(true);
    setMsg(null);
    const res = await api("/api/admin/auth/google/bind", {
      method: "POST",
      body: JSON.stringify({ idToken }),
    });
    setBusy(false);
    if (res.ok) {
      const d = await res.json();
      setBoundEmail(d.googleEmail ?? null);
      setMsg({ kind: "success", text: `Connected ${d.googleEmail}. You can now sign in with Google.` });
    } else {
      const d = await res.json().catch(() => ({}));
      setMsg({ kind: "error", text: d.error ?? "Could not connect the Google account." });
    }
  }

  async function unbind() {
    setBusy(true);
    setMsg(null);
    const res = await api("/api/admin/auth/google/bind", { method: "DELETE" });
    setBusy(false);
    if (res.ok) {
      setBoundEmail(null);
      setMsg({ kind: "info", text: "Disconnected. You can still sign in with your password." });
    }
  }

  const canBind = savedEnabled && savedClientId.length > 0;

  return (
    <div className="space-y-6">
      <Card title="Google login" subtitle="“Sign in with Google” for both the public /webapp chat and this admin panel.">
        <div className="space-y-4">
          <Field
            label="Client ID"
            value={clientId}
            onChange={setClientId}
            required
            placeholder="1234567890-abc.apps.googleusercontent.com"
            help="Google Cloud Console → APIs &amp; Services → Credentials → your OAuth 2.0 Web client. Public value."
          />
          <Field
            label={secretConfigured ? "Client secret (configured — leave blank to keep)" : "Client secret"}
            type="password"
            value={clientSecret}
            onChange={setClientSecret}
            placeholder={secretConfigured ? "••••••••" : ""}
            help="Same Credentials screen. Stored encrypted. Not needed for sign-in itself, but REQUIRED for the in-chat Gmail connection (the OAuth code exchange)."
          />
          <Field
            label="Allowed email domain (optional)"
            value={allowedEmailDomain}
            onChange={setAllowedEmailDomain}
            placeholder="example.com"
            help="Restrict sign-in to one Google Workspace domain. Leave blank to allow any Google account."
          />
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-black/20 dark:border-white/20"
            />
            Enable Google sign-in
          </label>
          {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={busy}>
              Save
            </Button>
          </div>
          {origin && (
            <div className="space-y-1 text-xs text-black/55 dark:text-white/55">
              <div>
                Authorized JS origin to add in Google: <code>{origin}</code>
              </div>
              <div>
                Authorized redirect URI to add (for the in-chat Gmail connection):{" "}
                <code>{origin}/api/chat/gmail/oauth/callback</code>
              </div>
            </div>
          )}
        </div>
      </Card>

      <Card
        title="Your Google account"
        subtitle="Link this admin account to a Google identity so you can sign in with Google."
        right={boundEmail ? <Badge tone="green">Connected</Badge> : <Badge tone="gray">Not connected</Badge>}
      >
        {boundEmail ? (
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm">
              Linked to <strong>{boundEmail}</strong>.
            </span>
            <Button variant="danger" size="sm" onClick={unbind} disabled={busy}>
              Disconnect
            </Button>
          </div>
        ) : canBind ? (
          <div className="space-y-3">
            <p className="text-sm text-black/60 dark:text-white/60">
              Click below and choose the Google account you want to use for admin sign-in.
            </p>
            <GoogleSignInButton clientId={savedClientId} onCredential={bind} text="continue_with" />
          </div>
        ) : (
          <p className="text-sm text-black/60 dark:text-white/60">
            Enter your Client ID above, tick <strong>Enable Google sign-in</strong>, and <strong>Save</strong> —
            then you can connect your account here.
          </p>
        )}
      </Card>

      <Card title="Setup guide — every parameter">
        <ol className="list-decimal space-y-2 pl-5 text-sm text-black/70 dark:text-white/70">
          <li>
            Go to <code>console.cloud.google.com</code> → create/select a project.
          </li>
          <li>
            <strong>OAuth consent screen</strong> → User type <strong>External</strong> → fill App name, user
            support email, developer contact. Scopes: <code>openid</code>, <code>email</code>,{" "}
            <code>profile</code> (no Gemini scopes — Gemini uses each user’s own API key).
          </li>
          <li>
            While in <em>Testing</em>, add your Google email under <strong>Test users</strong>. To open it to
            everyone, <strong>Publish app</strong> (no review needed for openid/email/profile).
          </li>
          <li>
            <strong>Credentials → Create credentials → OAuth client ID → Web application</strong>. Under{" "}
            <strong>Authorized JavaScript origins</strong> add{" "}
            <code>{origin || "http://localhost:38378"}</code> (and your production URL). Redirect URIs aren’t
            required for this sign-in flow.
          </li>
          <li>
            Copy the <strong>Client ID</strong> and <strong>Client secret</strong> into the fields above, tick
            Enable, and Save. Then connect your account in “Your Google account”.
          </li>
          <li>
            End users get their own free Gemini key at <code>aistudio.google.com/apikey</code> and paste it in
            the chat — it stays in their browser only.
          </li>
        </ol>
      </Card>

      <Card title="Gmail connection (in-chat)" subtitle="Extra setup so users can let the assistant read their Gmail. Users connect only by asking in the chat — there is no settings button.">
        <ol className="list-decimal space-y-2 pl-5 text-sm text-black/70 dark:text-white/70">
          <li>
            <strong>Enable the Gmail API</strong>: APIs &amp; Services → Library → search “Gmail API” → Enable.
          </li>
          <li>
            On the consent screen’s <strong>Data access / Scopes</strong>, add{" "}
            <code>https://www.googleapis.com/auth/gmail.readonly</code> (a <em>restricted</em> scope).
          </li>
          <li>
            On the same OAuth Web client, under <strong>Authorized redirect URIs</strong>, add{" "}
            <code>{origin ? `${origin}/api/chat/gmail/oauth/callback` : "https://<your-host>/api/chat/gmail/oauth/callback"}</code>{" "}
            (exact match; separate list from the JS origins).
          </li>
          <li>
            Make sure the <strong>Client secret</strong> above is filled in — the Gmail flow needs it.
          </li>
          <li>
            While the app’s publishing status is <em>Testing</em>, only <strong>Test users</strong> can connect
            (max 100) and Google expires their access after ~7 days, so they must reconnect weekly. Going public
            with a Gmail scope requires Google’s restricted-scope verification plus a paid CASA security
            assessment — until then, stay in Testing.
          </li>
        </ol>
      </Card>
    </div>
  );
}
