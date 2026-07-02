"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText, Mic, PhoneOff, Sparkles, Volume2 } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "./types";
import { formatDuration } from "./lib/time";
import { formatSize } from "./lib/files";
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
  const scrollToEnd = useCallback((behavior: ScrollBehavior) => {
    endRef.current?.scrollIntoView({ behavior, block: "end" });
  }, []);
  useEffect(() => {
    scrollToEnd("smooth");
  }, [messages, scrollSignal, scrollToEnd]);
  // Instant (non-smooth) follow while a reply types itself out word by word — queueing a smooth
  // scroll per word would lag behind the reveal.
  const followReveal = useCallback(() => scrollToEnd("auto"), [scrollToEnd]);

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
              {m.files && m.files.length > 0 && (
                <div className={`flex flex-col gap-1.5 ${m.text ? "mb-2" : ""}`}>
                  {m.files.map((f) =>
                    f.kind === "image" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={f.id}
                        src={`data:${f.mimeType};base64,${f.base64}`}
                        alt={t.message.imageAlt}
                        className="max-h-64 w-full rounded-xl object-contain"
                      />
                    ) : (
                      <span key={f.id} className="flex items-center gap-2 rounded-xl bg-white/15 px-3 py-2">
                        <FileText size={16} className="shrink-0 opacity-90" aria-hidden="true" />
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-medium" title={f.name}>{f.name}</span>
                          <span className="block text-[10px] opacity-75">{formatSize(f.size)}</span>
                        </span>
                      </span>
                    ),
                  )}
                </div>
              )}
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
          <AssistantMessage key={m.id} m={m} onPlayAudio={onPlayAudio} onReveal={followReveal} />
        ),
      )}
      <div ref={endRef} />
    </div>
  );
}

// A pending reply stays invisible this long before the "typing…" dots appear. Replies that land
// sooner skip the indicator entirely — like a person who just starts typing.
const TYPING_DELAY_MS = 2000;

// An assistant reply, staged to feel like a person on the other end:
// 1. For the first 2s nothing renders at all — no avatar, no bubble — as if they haven't reacted yet.
// 2. Past 2s with no reply, the avatar appears with a "typing…" dots bubble.
// 3. Once text lands it's revealed word by word (brisk, not dumped in one go) — see useWordReveal.
// Only replies that mount mid-stream animate; completed history (e.g. live-call transcripts) and
// errors render in full immediately.
function AssistantMessage({
  m,
  onPlayAudio,
  onReveal,
}: {
  m: ChatMessage;
  onPlayAudio: (m: ChatMessage) => void;
  onReveal: () => void;
}) {
  const t = useT();
  const mountedStreaming = useRef(!!m.streaming).current;
  const text = useWordReveal(m.text, mountedStreaming && !m.error);
  const [typingDots, setTypingDots] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setTypingDots(true), TYPING_DELAY_MS);
    return () => clearTimeout(id);
  }, []);
  // Keep the view pinned to the bottom as words land.
  useEffect(() => {
    if (text) onReveal();
  }, [text, onReveal]);

  if (!text && !m.error) {
    if (!typingDots) return null; // silent grace period — the reply may land before "typing" ever shows
    return (
      <div className="flex items-start gap-3">
        <AiAvatar />
        <Bubble>
          <span className="flex items-center gap-1 py-1" aria-label="Assistant is typing" role="status">
            <span className="h-2 w-2 animate-bounce rounded-full bg-black/40 [animation-delay:-0.3s] dark:bg-white/40" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-black/40 [animation-delay:-0.15s] dark:bg-white/40" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-black/40 dark:bg-white/40" />
          </span>
        </Bubble>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <AiAvatar />
      <Bubble>
        <div className={m.error ? "text-red-600 dark:text-red-400" : ""}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={md}>
            {text}
          </ReactMarkdown>
        </div>
        {m.audio && (
          <button
            onClick={() => onPlayAudio(m)}
            className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-black/5 px-3 py-1 text-xs font-medium transition hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
          >
            <Volume2 size={13} /> {t.message.playReply}
          </button>
        )}
      </Bubble>
    </div>
  );
}

// Word-by-word reveal of `text` (which may itself still be growing while the reply streams in).
// Each tick costs a full re-render (markdown re-parse + scroll), so the tick is pinned near frame
// rate and several words land per tick — sequential enough to read as typing, but never sluggish.
// A queued backlog scales the step up so the tail of a big reply lands in about a second.
// Disabled → the full text, as-is.
const REVEAL_TICK_MS = 16;
const REVEAL_WORDS_PER_TICK = 2;

function useWordReveal(text: string, enabled: boolean): string {
  const tokens = useMemo(() => text.match(/\S+\s*/g) ?? [], [text]);
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!enabled || shown >= tokens.length) return;
    const id = setTimeout(
      () => setShown((s) => s + Math.max(REVEAL_WORDS_PER_TICK, Math.floor((tokens.length - s) / 10))),
      REVEAL_TICK_MS,
    );
    return () => clearTimeout(id);
  }, [enabled, shown, tokens.length]);
  if (!enabled) return text;
  return tokens.slice(0, Math.min(shown, tokens.length)).join("");
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

function AiAvatar() {
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-blue-500 to-violet-500 shadow-sm">
      <Sparkles className="h-4 w-4 text-white" aria-hidden="true" />
    </div>
  );
}

function Bubble({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-[80%] rounded-2xl rounded-tl-sm border border-black/10 bg-white px-4 py-2.5 text-sm shadow-sm dark:border-white/10 dark:bg-neutral-900">
      {children}
    </div>
  );
}
