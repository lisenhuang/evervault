"use client";

import { useState } from "react";
import { MessageCircle } from "lucide-react";
import GoogleSignInButton from "@/components/GoogleSignInButton";
import { useT } from "@/i18n/LanguageProvider";
import { api } from "./authApi";

export default function SignInGate({ clientId, onSignedIn }: { clientId: string; onSignedIn: () => void }) {
  const t = useT();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onCredential(idToken: string) {
    setError("");
    setBusy(true);
    const res = await api("/api/auth/google", { method: "POST", body: JSON.stringify({ idToken }) });
    setBusy(false);
    if (res.ok) {
      onSignedIn();
      return;
    }
    const d = await res.json().catch(() => ({}));
    setError(d.error ?? t.signin.failed);
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm rounded-2xl border border-black/10 bg-white/70 p-8 text-center shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/5">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-linear-to-br from-blue-500 to-violet-500 shadow-md">
          <MessageCircle className="h-7 w-7 text-white" aria-hidden="true" />
        </div>
        <h1 className="text-xl font-semibold">{t.signin.gateTitle}</h1>
        <p className="mt-2 text-sm text-black/55 dark:text-white/55">
          {t.signin.gateBody}
        </p>
        <div className="mt-6 flex justify-center">
          <GoogleSignInButton clientId={clientId} onCredential={onCredential} text="continue_with" />
        </div>
        {busy && <p className="mt-3 text-xs text-black/50 dark:text-white/50">{t.signin.signingIn}</p>}
        {error && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </div>
  );
}
