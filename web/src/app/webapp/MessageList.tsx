"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileAudio, FileText, Mic, PhoneOff, Play, Reply, Sparkles, Volume2 } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import MessageMenu from "./MessageMenu";
import type { ChatMessage, ReplyRef } from "./types";
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

// How long the jumped-to original message stays tinted after tapping a quote.
const FLASH_MS = 1500;

// Extra classes shared by every message row: `group` drives the hover reply button, the
// horizontal bleed (-mx/px) lets the flash tint breathe past the bubbles without touching the
// vertical rhythm (space-y on the list would lose to a vertical margin set here).
const rowFlashCls = (flashing: boolean) =>
  `group -mx-2 rounded-2xl px-2 transition-colors duration-500 ${
    flashing ? "bg-blue-500/10 dark:bg-blue-400/15" : ""
  }`;

// Three little bars pulsing while a reply's audio is playing — a lightweight "now playing"
// equalizer. Reuses the call bar's scaleY `wave` keyframes (staggered per bar), which keeps the
// bars inside their box — unlike a translate animation, which would jump them into the button's
// edge. The h-3 box matches the 13px icons of the other button states; bg-current keeps it in
// step with the button's text color in light and dark.
const EQ_DELAYS = ["-0.6s", "-0.4s", "-0.2s"];
function EqualizerBars() {
  return (
    <span className="flex h-3 items-center gap-0.5" aria-hidden="true">
      {EQ_DELAYS.map((d) => (
        <span
          key={d}
          className="h-full w-0.5 origin-center animate-wave rounded-full bg-current"
          style={{ animationDelay: d }}
        />
      ))}
    </span>
  );
}

export default function MessageList({
  messages,
  userName,
  userPicture,
  onPlayAudio,
  playingAudioId,
  audioPaused,
  onReply,
  scrollSignal,
}: {
  messages: ChatMessage[];
  userName: string;
  userPicture: string | null;
  onPlayAudio: (m: ChatMessage) => void;
  /** Id of the reply whose audio is loaded in the player, or null when nothing is loaded. */
  playingAudioId: string | null;
  /** Whether that loaded reply is currently paused (vs actively playing). */
  audioPaused: boolean;
  /** Start composing a reply that quotes this message. */
  onReply: (m: ChatMessage) => void;
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

  // Context menu for one message, opened by right-click (desktop) or long-press (touch).
  const [menu, setMenu] = useState<{ m: ChatMessage; x: number; y: number } | null>(null);
  const openMenu = useCallback((m: ChatMessage, x: number, y: number) => setMenu({ m, x, y }), []);

  // Tapping a quote scrolls to the original message and briefly tints it.
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jumpTo = useCallback((id: string) => {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashId(id);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashId(null), FLASH_MS);
  }, []);
  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

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
          <div
            key={m.id}
            id={`msg-${m.id}`}
            className={`flex items-start justify-end gap-3 ${rowFlashCls(flashId === m.id)}`}
          >
            <HoverReplyButton label={t.message.reply} onClick={() => onReply(m)} />
            <Pressable
              onOpen={(x, y) => openMenu(m, x, y)}
              className="max-w-[80%] rounded-2xl rounded-tr-sm bg-blue-600 px-4 py-2.5 text-sm text-white shadow-sm [-webkit-touch-callout:none] [@media(hover:none)]:select-none"
            >
              {m.replyTo && <QuotedReply r={m.replyTo} onJump={jumpTo} />}
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
                        {f.kind === "audio" ? (
                          <FileAudio size={16} className="shrink-0 opacity-90" aria-hidden="true" />
                        ) : (
                          <FileText size={16} className="shrink-0 opacity-90" aria-hidden="true" />
                        )}
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
            </Pressable>
            <Avatar name={userName} picture={userPicture} />
          </div>
        ) : (
          <AssistantMessage
            key={m.id}
            m={m}
            flashing={flashId === m.id}
            audioState={playingAudioId === m.id ? (audioPaused ? "paused" : "playing") : "idle"}
            onPlayAudio={onPlayAudio}
            onReveal={followReveal}
            onOpenMenu={openMenu}
            onReply={onReply}
          />
        ),
      )}
      <div ref={endRef} />
      {menu && (
        <MessageMenu
          message={menu.m}
          x={menu.x}
          y={menu.y}
          onReply={() => {
            setMenu(null);
            onReply(menu.m);
          }}
          onClose={() => setMenu(null)}
        />
      )}
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
  flashing,
  audioState,
  onPlayAudio,
  onReveal,
  onOpenMenu,
  onReply,
}: {
  m: ChatMessage;
  flashing: boolean;
  /** Playback state of this reply's spoken audio: idle, actively playing, or paused mid-clip. */
  audioState: "idle" | "playing" | "paused";
  onPlayAudio: (m: ChatMessage) => void;
  onReveal: () => void;
  onOpenMenu: (m: ChatMessage, x: number, y: number) => void;
  onReply: (m: ChatMessage) => void;
}) {
  const t = useT();
  // Whether this reply mounted mid-stream, captured once at mount — history never animates.
  const [mountedStreaming] = useState(!!m.streaming);
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

  // While `pendingAudio` is set the text has streamed in but is deliberately withheld until the
  // spoken audio is ready — keep the bubble on the "typing"/speaking dots as if the reply is still
  // being prepared, so text never races ahead of the voice.
  if ((!text || m.pendingAudio) && !m.error) {
    if (!typingDots) return null; // silent grace period — the reply may land before "typing" ever shows
    return (
      <div className="flex items-start gap-3">
        <AiAvatar />
        <div className={BUBBLE_CLS}>
          <span className="flex items-center gap-1 py-1" aria-label="Assistant is typing" role="status">
            <span className="h-2 w-2 animate-bounce rounded-full bg-black/40 [animation-delay:-0.3s] dark:bg-white/40" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-black/40 [animation-delay:-0.15s] dark:bg-white/40" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-black/40 dark:bg-white/40" />
          </span>
        </div>
      </div>
    );
  }

  return (
    <div id={`msg-${m.id}`} className={`flex items-start gap-3 ${rowFlashCls(flashing)}`}>
      <AiAvatar />
      <Pressable
        disabled={!!m.streaming}
        onOpen={(x, y) => onOpenMenu(m, x, y)}
        className={`${BUBBLE_CLS} [-webkit-touch-callout:none] [@media(hover:none)]:select-none`}
      >
        <div className={m.error ? "text-red-600 dark:text-red-400" : ""}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={md}>
            {text}
          </ReactMarkdown>
        </div>
        {m.audio && (
          <button
            onClick={() => onPlayAudio(m)}
            aria-label={
              audioState === "playing" ? t.message.pauseReply : audioState === "paused" ? t.message.resumeReply : t.message.playReply
            }
            className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-black/5 px-3 py-1 text-xs font-medium transition hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
          >
            {audioState === "playing" ? (
              <>
                <EqualizerBars /> {t.message.pauseReply}
              </>
            ) : audioState === "paused" ? (
              <>
                <Play size={13} /> {t.message.resumeReply}
              </>
            ) : (
              <>
                <Volume2 size={13} /> {t.message.playReply}
              </>
            )}
          </button>
        )}
      </Pressable>
      {!m.streaming && <HoverReplyButton label={t.message.reply} onClick={() => onReply(m)} />}
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

// Long-press timing for the touch path (iOS never fires `contextmenu`; Android does, but the two
// paths converge on the same open call). Small drags within the tolerance still count as a press.
const LONG_PRESS_MS = 450;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

/**
 * Makes its children open the message menu: right-click / two-finger-tap via `contextmenu`
 * (default menu suppressed), and long-press via a touch timer for browsers that don't map
 * long-press to `contextmenu` (iOS Safari). Callers should pair this with
 * `[@media(hover:none)]:select-none` so long-press doesn't fight text selection on touch.
 */
function Pressable({
  onOpen,
  disabled,
  className,
  children,
}: {
  onOpen: (x: number, y: number) => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef({ x: 0, y: 0 });
  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  useEffect(() => clear, [clear]);

  return (
    <div
      className={className}
      onContextMenu={(e) => {
        if (disabled) return;
        e.preventDefault();
        onOpen(e.clientX, e.clientY);
      }}
      onTouchStart={(e) => {
        if (disabled || e.touches.length !== 1) {
          clear();
          return;
        }
        const touch = e.touches[0];
        start.current = { x: touch.clientX, y: touch.clientY };
        clear();
        timer.current = setTimeout(() => {
          timer.current = null;
          navigator.vibrate?.(10);
          onOpen(start.current.x, start.current.y);
        }, LONG_PRESS_MS);
      }}
      onTouchMove={(e) => {
        const touch = e.touches[0];
        if (
          touch &&
          Math.hypot(touch.clientX - start.current.x, touch.clientY - start.current.y) >
            LONG_PRESS_MOVE_TOLERANCE_PX
        ) {
          clear();
        }
      }}
      onTouchEnd={clear}
      onTouchCancel={clear}
    >
      {children}
    </div>
  );
}

// The quote block atop a user message sent as a reply — tap to jump back to the original.
function QuotedReply({ r, onJump }: { r: ReplyRef; onJump: (id: string) => void }) {
  const t = useT();
  return (
    <button
      onClick={() => onJump(r.id)}
      title={t.message.jumpToMessage}
      className="mb-2 block w-full rounded-lg border-l-2 border-white/70 bg-white/15 px-2.5 py-1.5 text-left transition hover:bg-white/25"
    >
      <span className="block text-[11px] font-semibold text-white/95">
        {r.role === "user" ? t.message.you : t.message.assistantName}
      </span>
      <span className="line-clamp-2 block text-xs text-white/80">{r.text || t.message.voiceMessage}</span>
    </button>
  );
}

// Quick reply affordance beside a bubble — hover-only, so it exists just on pointer devices
// (touch users long-press instead). Also reachable by keyboard via focus-visible.
function HoverReplyButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="hidden h-7 w-7 shrink-0 items-center justify-center self-center rounded-full text-black/40 opacity-0 transition group-hover:opacity-100 hover:bg-black/5 hover:text-black/70 focus-visible:opacity-100 dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white/70 [@media(hover:hover)]:flex"
    >
      <Reply size={15} aria-hidden="true" />
    </button>
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

function AiAvatar() {
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-blue-500 to-violet-500 shadow-sm">
      <Sparkles className="h-4 w-4 text-white" aria-hidden="true" />
    </div>
  );
}

const BUBBLE_CLS =
  "max-w-[80%] rounded-2xl rounded-tl-sm border border-black/10 bg-white px-4 py-2.5 text-sm shadow-sm dark:border-white/10 dark:bg-neutral-900";
