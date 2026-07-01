"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, PhoneOff, Sparkles, Volume2 } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "./types";
import { formatDuration } from "./lib/time";
import { useT } from "@/i18n/LanguageProvider";

const md: Components = {
  p: (props) => <p className="mb-2 last:mb-0" {...props} />,
  ul: (props) => <ul className="mb-2 list-disc pl-5" {...props} />,
  ol: (props) => <ol className="mb-2 list-decimal pl-5" {...props} />,
  li: (props) => <li className="mb-0.5" {...props} />,
  a: (props) => <a className="underline underline-offset-2" target="_blank" rel="noreferrer" {...props} />,
  pre: (props) => (
    <pre className="mb-2 overflow-x-auto rounded-lg bg-black/80 p-3 text-xs text-white dark:bg-black/60" {...props} />
  ),
  code: ({ className, children, ...props }) => {
    const isBlock = /language-/.test(className ?? "");
    return isBlock ? (
      <code className={className} {...props}>
        {children}
      </code>
    ) : (
      <code className="rounded bg-black/10 px-1 py-0.5 text-[0.85em] dark:bg-white/15" {...props}>
        {children}
      </code>
    );
  },
};

export default function MessageList({
  messages,
  userName,
  userPicture,
  onPlayAudio,
  scrollSignal,
}: {
  messages: ChatMessage[];
  userName: string;
  userPicture: string | null;
  onPlayAudio: (m: ChatMessage) => void;
  // Bump this to re-pin to the bottom even when `messages` didn't change — e.g. when the call bar
  // mounts/unmounts and shrinks the scroll area, which would otherwise clip the last message.
  scrollSignal?: unknown;
}) {
  const t = useT();
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, scrollSignal]);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-6">
      {messages.map((m) =>
        m.kind === "call" ? (
          // Centered system chip logged when a realtime call ends — shows how long it lasted.
          <div key={m.id} className="flex justify-center">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-black/5 px-3 py-1 text-xs font-medium text-black/55 dark:bg-white/10 dark:text-white/55">
              <PhoneOff size={13} aria-hidden="true" />
              {t.message.callEnded}
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">{formatDuration(m.durationSec ?? 0)}</span>
            </span>
          </div>
        ) : m.role === "user" ? (
          <div key={m.id} className="flex items-start justify-end gap-3">
            <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-blue-600 px-4 py-2.5 text-sm text-white shadow-sm">
              {m.kind === "voice" ? (
                m.text ? (
                  <span className="flex items-start gap-1.5">
                    <Mic size={14} className="mt-0.5 shrink-0 opacity-90" aria-hidden="true" />
                    <span className="whitespace-pre-wrap">{m.text}</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 italic opacity-90">
                    <Mic size={14} aria-hidden="true" /> {t.message.voiceMessage}
                  </span>
                )
              ) : (
                <span className="whitespace-pre-wrap">{m.text}</span>
              )}
            </div>
            <Avatar name={userName} picture={userPicture} />
          </div>
        ) : (
          <AssistantMessage key={m.id} m={m} onPlayAudio={onPlayAudio} />
        ),
      )}
      <div ref={endRef} />
    </div>
  );
}

function AssistantMessage({ m, onPlayAudio }: { m: ChatMessage; onPlayAudio: (m: ChatMessage) => void }) {
  const t = useT();
  // A voice reply that hasn't started arriving yet: like texting a person, hold everything back for a
  // beat and then show a "typing…" indicator — never an empty bubble. A reply that lands within the
  // pause pops straight in with no indicator at all.
  const pendingVoice = !!m.streaming && !m.text && m.kind === "voice";
  const [revealed, setRevealed] = useState(!pendingVoice);
  useEffect(() => {
    if (!pendingVoice) {
      setRevealed(true);
      return;
    }
    const id = setTimeout(() => setRevealed(true), 2000);
    return () => clearTimeout(id);
  }, [pendingVoice]);

  // Show nothing at all — no avatar, no bubble — until the typing indicator is revealed.
  if (pendingVoice && !revealed) return null;

  return (
    <div className="flex items-start gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-blue-500 to-violet-500 shadow-sm">
        <Sparkles className="h-4 w-4 text-white" aria-hidden="true" />
      </div>
      <div className="max-w-[80%] rounded-2xl rounded-tl-sm border border-black/10 bg-white px-4 py-2.5 text-sm shadow-sm dark:border-white/10 dark:bg-neutral-900">
        {m.text ? (
          <div className={m.error ? "text-red-600 dark:text-red-400" : ""}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={md}>
              {m.text}
            </ReactMarkdown>
          </div>
        ) : m.streaming ? (
          // Voice replies get a human "typing…" indicator; everything else keeps the immediate spinner.
          m.kind === "voice" ? (
            <TypingDots />
          ) : (
            <Loader2 size={16} className="animate-spin text-black/40 dark:text-white/40" />
          )
        ) : null}
        {m.audio && (
          <button
            onClick={() => onPlayAudio(m)}
            className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-black/5 px-3 py-1 text-xs font-medium transition hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
          >
            <Volume2 size={13} /> {t.message.playReply}
          </button>
        )}
      </div>
    </div>
  );
}

// Animated three-dot "typing…" indicator (presentational — the reveal timing lives in AssistantMessage).
function TypingDots() {
  return (
    <span className="flex items-center gap-1 py-1" aria-label="Assistant is typing" role="status">
      <span className="h-2 w-2 animate-bounce rounded-full bg-black/40 [animation-delay:-0.3s] dark:bg-white/40" />
      <span className="h-2 w-2 animate-bounce rounded-full bg-black/40 [animation-delay:-0.15s] dark:bg-white/40" />
      <span className="h-2 w-2 animate-bounce rounded-full bg-black/40 dark:bg-white/40" />
    </span>
  );
}

function Avatar({ name, picture }: { name: string; picture: string | null }) {
  return picture ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={picture} alt={name} className="h-8 w-8 shrink-0 rounded-full object-cover shadow-sm" />
  ) : (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/10 text-xs font-semibold dark:bg-white/15">
      {(name || "?").charAt(0).toUpperCase()}
    </div>
  );
}
