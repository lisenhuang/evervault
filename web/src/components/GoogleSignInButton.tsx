"use client";

import { useEffect, useRef } from "react";

// Minimal wrapper over Google Identity Services (GIS). We load the official script and render
// Google's own button, which yields an ID token ("credential") we hand to our backend. No npm
// dependency / no React peer-version risk, and the button styling stays consistent with Google.

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
  window.__gsiLoading = new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load Google sign-in."));
    document.head.appendChild(s);
  });
  return window.__gsiLoading;
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
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onCredential);
  useEffect(() => {
    cb.current = onCredential;
  }, [onCredential]);

  useEffect(() => {
    let cancelled = false;
    void loadGsi()
      .then(() => {
        if (cancelled || !ref.current || !window.google?.accounts?.id) return;
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
      })
      .catch(() => {
        /* surfaced by the caller's own error UI if needed */
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, text, theme]);

  return <div ref={ref} className="flex justify-center" />;
}
