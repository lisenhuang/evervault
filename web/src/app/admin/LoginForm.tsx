"use client";

import { useState } from "react";
import { api } from "./adminApi";
import { Banner, Button, Card, Field } from "./ui";

export default function LoginForm({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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

  return (
    <Card title="Sign in">
      <div className="space-y-4">
        <Field label="Email" type="email" value={email} onChange={setEmail} required placeholder="you@example.com" />
        <Field label="Password" type="password" value={password} onChange={setPassword} required />
        {error && <Banner kind="error">{error}</Banner>}
        <Button onClick={submit} disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </div>
    </Card>
  );
}
