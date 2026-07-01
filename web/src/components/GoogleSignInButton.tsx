"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "@/i18n/LanguageProvider";

// Minimal wrapper over Google Identity Services (GIS). We load the official script and render
// Google's own button, which yields an ID token ("credential") we hand to our backend. No npm
// dependency / no React peer-version risk, and the button styling stays consistent with Google.
//
// Google draws its button only after gsi/client loads. On networks where Google is unreachable
// that script never loads, so we always render our own look-alike button first and swap in
// Google's real button the moment the script arrives. Clicking the fallback re-attempts the
// load, so if the network later becomes able to reach Google the button starts working.

type GoogleIdConfig = {
  client_id: string;
  callback: (resp: { credential: string }) => void;
  auto_select?: boolean;
};
type GoogleButtonOptions = {
  type?: "standard" | "icon";
  theme?: "outline" | "filled_blue" | "filled_black";
  size?: "small" | "medium" | "large";
  text?: "signin_with" | "signup_with" | "continue_with" | "signin";
  shape?: "rectangular" | "pill" | "circle" | "square";
  logo_alignment?: "left" | "center";
  width?: number;
};
type GoogleAccountsId = {
  initialize: (config: GoogleIdConfig) => void;
  renderButton: (el: HTMLElement, options: GoogleButtonOptions) => void;
  cancel: () => void;
};

declare global {
  interface Window {
    google?: { accounts: { id: GoogleAccountsId } };
    __gsiLoading?: Promise<void>;
  }
}

function loadGsi(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.google?.accounts?.id) return Promise.resolve();
  if (window.__gsiLoading) return window.__gsiLoading;
  const p = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => {
      // Drop the dead tag and clear the cache so a later retry actually re-attempts the load
      // (otherwise the rejected promise stays cached and every retry fails without a new request).
      s.remove();
      window.__gsiLoading = undefined;
      reject(new Error("Failed to load Google sign-in."));
    };
    document.head.appendChild(s);
  });
  window.__gsiLoading = p;
  return p;
}

// Official 4-color Google "G" mark (brand asset, not a UI icon set — lucide has no Google logo).
function GoogleG({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

export default function GoogleSignInButton({
  clientId,
  onCredential,
  text = "signin_with",
  theme = "outline",
}: {
  clientId: string;
  onCredential: (idToken: string) => void;
  text?: GoogleButtonOptions["text"];
  theme?: GoogleButtonOptions["theme"];
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onCredential);
  const mounted = useRef(true);
  // Starts false on the server and first client render (fallback shown → no hydration mismatch);
  // flips to true only after Google's script loads and its real button has rendered.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    cb.current = onCredential;
  }, [onCredential]);

  // Load GIS and render Google's real button. Shared by the mount effect and the fallback click,
  // so a click quietly re-attempts the load. Failures leave the fallback in place — no message.
  const attempt = useCallback(() => {
    return loadGsi()
      .then(() => {
        if (!mounted.current || !ref.current || !window.google?.accounts?.id) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (resp) => cb.current(resp.credential),
        });
        ref.current.replaceChildren();
        window.google.accounts.id.renderButton(ref.current, {
          type: "standard",
          theme,
          size: "large",
          text,
          shape: "pill",
          logo_alignment: "left",
        });
        if (mounted.current) setReady(true);
      })
      .catch(() => {
        /* stay on the fallback button — chosen behavior is "just show it, no message" */
      });
  }, [clientId, text, theme]);

  useEffect(() => {
    mounted.current = true;
    void attempt();
    return () => {
      mounted.current = false;
    };
  }, [attempt]);

  const label = text === "signin_with" ? t.signin.googleSignIn : t.signin.googleContinue;

  return (
    <div className="flex justify-center">
      {/* Google renders its real button here once GIS loads; kept mounted so ref.current is
          available across the async load. Hidden until the real button is live. */}
      <div ref={ref} className={ready ? "flex justify-center" : "hidden"} />
      {/* Always-present look-alike so the button is never blank; clicking re-attempts the load. */}
      {!ready && (
        <button
          type="button"
          onClick={() => void attempt()}
          aria-label={label}
          className="inline-flex items-center justify-center gap-3 rounded-full border border-black/15 bg-white px-6 py-2.5 text-sm font-medium text-black/80 shadow-sm transition hover:bg-black/3 dark:border-white/20 dark:bg-neutral-900 dark:text-white/90 dark:hover:bg-white/5"
        >
          <GoogleG className="h-5 w-5" />
          <span>{label}</span>
        </button>
      )}
    </div>
  );
}
