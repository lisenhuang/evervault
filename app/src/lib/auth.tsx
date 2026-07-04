// End-user authentication for the app. Google login runs in an in-app browser (Chrome Custom Tab /
// SFSafariViewController) against the backend's OAuth flow — the app needs no native Google config and
// no client id. The backend redirects back to evervault://auth?token=… ; we store that bearer token in
// the secure keystore and send it on every request.

import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { API_BASE, AUTH_REDIRECT } from "@/config";
import { apiFetch } from "./api";
import { clearToken, setToken } from "./session";

export type Me = { email: string; name: string; picture: string | null };
export type AuthStatus = "loading" | "disabled" | "signedOut" | "signedIn";

type AuthContextValue = {
  status: AuthStatus;
  me: Me | null;
  signingIn: boolean;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  deleteAccount: () => Promise<boolean>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const ERROR_MESSAGES: Record<string, string> = {
  auth_failed: "Google sign-in failed. Please try again.",
  email_unverified: "Your Google email address isn't verified.",
  no_code: "Sign-in was cancelled.",
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolve the current session: a valid token → signedIn; otherwise gate on whether Google login is
  // enabled server-side (disabled vs. sign-in screen).
  const refresh = useCallback(async () => {
    const meRes = await apiFetch("/auth/me");
    if (meRes.ok) {
      setMe((await meRes.json()) as Me);
      setStatus("signedIn");
      return;
    }
    try {
      const cfgRes = await apiFetch("/auth/config");
      const cfg = cfgRes.ok ? await cfgRes.json() : { enabled: false };
      setStatus(cfg.enabled ? "signedOut" : "disabled");
    } catch {
      setStatus("signedOut");
    }
    setMe(null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(async () => {
    setError(null);
    setSigningIn(true);
    try {
      const startUrl = `${API_BASE}/auth/google/start?redirect_uri=${encodeURIComponent(AUTH_REDIRECT)}`;
      const result = await WebBrowser.openAuthSessionAsync(startUrl, AUTH_REDIRECT);
      if (result.type !== "success") return; // user dismissed/cancelled

      const { queryParams } = Linking.parse(result.url);
      const token = typeof queryParams?.token === "string" ? queryParams.token : null;
      const errCode = typeof queryParams?.error === "string" ? queryParams.error : null;
      if (errCode) {
        setError(ERROR_MESSAGES[errCode] ?? "Sign-in failed. Please try again.");
        return;
      }
      if (!token) {
        setError("Sign-in didn't complete. Please try again.");
        return;
      }
      await setToken(token);
      await refresh();
    } catch {
      setError("Could not open Google sign-in. Please try again.");
    } finally {
      setSigningIn(false);
    }
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } catch {
      /* best-effort */
    }
    await clearToken();
    setMe(null);
    setStatus("signedOut");
  }, []);

  const deleteAccount = useCallback(async () => {
    try {
      const res = await apiFetch("/auth/account", { method: "DELETE" });
      if (!res.ok) return false;
      await clearToken();
      setMe(null);
      setStatus("signedOut");
      return true;
    } catch {
      return false;
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, me, signingIn, error, signIn, signOut, deleteAccount, refresh }),
    [status, me, signingIn, error, signIn, signOut, deleteAccount, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
