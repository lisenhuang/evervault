"use client";

import { useEffect, useState } from "react";
import GoogleSignInButton from "@/components/GoogleSignInButton";
import { api } from "./adminApi";
import { Banner, Button, Card, Field } from "./ui";

export default function LoginForm({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [googleClientId, setGoogleClientId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/auth/config", { credentials: "include" });
      if (res.ok) {
        const d = await res.json();
        if (d.enabled && d.clientId) setGoogleClientId(d.clientId);
      }
    })();
  }, []);

  async function submit() {
    setError("");
    setBusy(true);
    const res = await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setBusy(false);
    if (res.ok) {
      onDone();
      return;
    }
    const data = await res.json().catch(() => ({}));
    setError(data.error ?? "Invalid email or password.");
  }

  async function googleLogin(idToken: string) {
    setError("");
    setBusy(true);
    const res = await api("/api/admin/login/google", {
      method: "POST",
      body: JSON.stringify({ idToken }),
    });
    setBusy(false);
    if (res.ok) {
      onDone();
      return;
    }
    const data = await res.json().catch(() => ({}));
    setError(data.error ?? "Could not sign in with Google.");
  }

  return (
    <Card title="Sign in">
      <div className="space-y-4">
        <Field label="Email" type="email" value={email} onChange={setEmail} required placeholder="you@example.com" />
        <Field label="Password" type="password" value={password} onChange={setPassword} required />
        {error && <Banner kind="error">{error}</Banner>}
        <Button onClick={submit} disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
        {googleClientId && (
          <>
            <div className="flex items-center gap-3 text-xs text-black/40 dark:text-white/40">
              <span className="h-px flex-1 bg-black/10 dark:bg-white/10" />
              or
              <span className="h-px flex-1 bg-black/10 dark:bg-white/10" />
            </div>
            <GoogleSignInButton clientId={googleClientId} onCredential={googleLogin} text="signin_with" />
          </>
        )}
      </div>
    </Card>
  );
}
