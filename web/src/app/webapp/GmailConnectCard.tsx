"use client";

// The in-chat "Connect Gmail" card — the ONLY place a user can connect their Gmail, and it appears
// only after they told the AI yes (the request_gmail_access tool appends a kind:"gmailConnect"
// message). The OAuth flow runs in a POPUP because chat history is in-memory: navigating this page
// would wipe the conversation. Completion is signaled two ways — a postMessage from our callback
// page AND status polling — because popup blockers, COOP, or a user finishing in a re-opened tab
// can all sever window.opener. The postMessage is a SIGNAL only; the card always re-fetches
// /api/chat/gmail/status and renders from that, never from popup-supplied data.

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, Mail, XCircle } from "lucide-react";
import { getGmailStatus } from "./lib/gmail";
import { useT } from "@/i18n/LanguageProvider";

type CardState = "loading" | "idle" | "connecting" | "connected" | "declined" | "error";

const POLL_MS = 3000;
const POLL_CAP_MS = 2 * 60 * 1000;
const START_URL = "/api/chat/gmail/connect/start";

export default function GmailConnectCard({ onConnected }: { onConnected?: (email: string | null) => void }) {
  const t = useT();
  const [state, setState] = useState<CardState>("loading");
  const [email, setEmail] = useState<string | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);

  const popupRef = useRef<Window | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const doneRef = useRef(false);

  const stopWatching = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Already connected (e.g. the model asked again, or the user reloaded mid-flow)? Show it.
  useEffect(() => {
    let alive = true;
    void getGmailStatus().then((s) => {
      if (!alive) return;
      if (s.connected && !s.needsReconnect) {
        setEmail(s.email);
        setState("connected");
      } else {
        setState("idle");
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  /** Final arbiter for every completion signal: ask the backend, render from that. `outcome` reflects
   * how the popup ended — "declined" (user said no / unticked), "error" (anything else went wrong), or
   * null (a poll tick with no verdict yet). Success is only ever trusted from the re-fetched status. */
  const settle = useCallback(
    async (outcome: "declined" | "error" | null) => {
      if (doneRef.current) return;
      const s = await getGmailStatus();
      if (doneRef.current) return;
      if (s.connected && !s.needsReconnect) {
        doneRef.current = true;
        stopWatching();
        setEmail(s.email);
        setState("connected");
        onConnected?.(s.email);
      } else if (outcome) {
        doneRef.current = true;
        stopWatching();
        setState(outcome);
      }
      // Not connected and no verdict yet: keep watching (the user may still be mid-consent).
    },
    [onConnected, stopWatching],
  );

  // The callback page postMessages {type:"ev-gmail-connect", ok, declined} from our own origin. The
  // payload is a signal only — success is confirmed via getGmailStatus, never trusted from here.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; ok?: boolean; declined?: boolean } | null;
      if (!data || data.type !== "ev-gmail-connect") return;
      void settle(data.ok ? null : data.declined ? "declined" : "error");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [settle]);

  useEffect(
    () => () => {
      stopWatching();
    },
    [stopWatching],
  );

  const watch = useCallback(() => {
    stopWatching();
    const startedAt = Date.now();
    pollRef.current = setInterval(() => {
      if (doneRef.current) return stopWatching();
      if (Date.now() - startedAt > POLL_CAP_MS) {
        stopWatching();
        setState((cur) => (cur === "connecting" ? "idle" : cur));
        return;
      }
      // Popup closed → one last check, then back to idle if nothing was granted.
      if (popupRef.current?.closed) {
        popupRef.current = null;
        void getGmailStatus().then((s) => {
          if (doneRef.current) return;
          if (s.connected && !s.needsReconnect) void settle(null);
          else {
            stopWatching();
            setState("idle");
          }
        });
        return;
      }
      void settle(null);
    }, POLL_MS);
  }, [settle, stopWatching]);

  const connect = useCallback(() => {
    doneRef.current = false;
    // window.open runs synchronously inside the click gesture and navigates straight to the backend
    // start endpoint (which 302s to Google) — no async fetch first, so popup blockers stay quiet.
    const w = window.open(START_URL, "ev-gmail-connect", "popup,width=520,height=680");
    popupRef.current = w;
    setPopupBlocked(!w);
    setState("connecting");
    watch();
  }, [watch]);

  if (state === "loading") return null;

  return (
    <div className="flex justify-center">
      <div className="w-full max-w-sm rounded-2xl border border-black/10 bg-white p-4 text-sm shadow-sm dark:border-white/10 dark:bg-neutral-900">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-500/10 text-blue-600 dark:bg-blue-400/15 dark:text-blue-400">
            <Mail size={18} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="font-semibold">{t.gmail.title}</div>
            <p className="text-xs text-black/55 dark:text-white/55">{t.gmail.description}</p>
          </div>
        </div>

        {state === "connected" ? (
          <div className="mt-3 flex items-center gap-1.5 text-xs font-medium text-green-700 dark:text-green-400">
            <CheckCircle2 size={14} aria-hidden="true" />
            {email ? t.gmail.connectedAs(email) : t.gmail.connected}
          </div>
        ) : state === "connecting" ? (
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-1.5 text-xs text-black/55 dark:text-white/55">
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              {t.gmail.connecting}
            </div>
            {popupBlocked && (
              <a
                href={START_URL}
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-1.5 rounded-full bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500"
              >
                <ExternalLink size={13} aria-hidden="true" />
                {t.gmail.openInNewTab}
              </a>
            )}
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            {(state === "declined" || state === "error") && (
              <div className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                <XCircle size={14} aria-hidden="true" />
                {state === "declined" ? t.gmail.declined : t.gmail.error}
              </div>
            )}
            <button
              type="button"
              onClick={connect}
              className="inline-flex items-center gap-1.5 rounded-full bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500"
            >
              <Mail size={13} aria-hidden="true" />
              {state === "idle" ? t.gmail.connect : t.gmail.tryAgain}
            </button>
            <p className="text-[11px] text-black/45 dark:text-white/45">{t.gmail.readOnlyNote}</p>
          </div>
        )}
      </div>
    </div>
  );
}
