"use client";

import { useState } from "react";
import { api } from "./adminApi";
import { Banner, Button, Card, Field } from "./ui";

export default function SetupForm({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError("");
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    const res = await api("/api/admin/setup", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setBusy(false);
    if (res.ok) {
      onDone();
      return;
    }
    const data = await res.json().catch(() => ({}));
    setError(data.error ?? "Could not create the admin account.");
  }

  return (
    <Card title="Create the admin account">
      <p className="mb-4 text-sm text-black/60 dark:text-white/60">
        One-time setup. Choose the email and password you’ll use to sign in. Once created, this
        page becomes the login screen.
      </p>
      <div className="space-y-4">
        <Field label="Email" type="email" value={email} onChange={setEmail} required placeholder="you@example.com" />
        <Field label="Password" type="password" value={password} onChange={setPassword} required help="At least 8 characters." />
        <Field label="Confirm password" type="password" value={confirm} onChange={setConfirm} required />
        {error && <Banner kind="error">{error}</Banner>}
        <Button onClick={submit} disabled={busy}>
          {busy ? "Creating…" : "Create account"}
        </Button>
      </div>
    </Card>
  );
}
