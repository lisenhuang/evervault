"use client";

import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Eraser,
  FileAudio,
  FileText,
  Image as ImageIcon,
  Loader2,
  Mic,
  Paperclip,
  PhoneOff,
  Play,
  Reply,
  Sparkles,
  Volume2,
} from "lucide-react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import MessageMenu from "./MessageMenu";
import ImageLightbox, { type LightboxImage } from "./ImageLightbox";
import FilePreview from "./FilePreview";
import type { ChatMessage, ReplyRef } from "./types";
import type { ForgetItem } from "./lib/forgetTool";
import { formatDuration, formatMemoryDate } from "./lib/time";
import { formatSize, openFileInNewTab, type PreparedFile } from "./lib/files";
import { isIOS } from "./lib/liveAudio";
import type { StoredFileMeta } from "./lib/filesApi";
import { linkify } from "./lib/linkify";
import { useT } from "@/i18n/LanguageProvider";

// How a link looks in a bubble, on either side: the color is inherited (white on the user's blue
// bubble, body text on the assistant's), so one class covers both the markdown `a` renderer below
// and the links `linkify` finds in the user's own plain text.
const LINK_CLS = "underline underline-offset-2";

const md: Components = {
  p: (props) => <p className="mb-2 last:mb-0" {...props} />,
  ul: (props) => <ul className="mb-2 list-disc pl-5" {...props} />,
  ol: (props) => <ol className="mb-2 list-decimal pl-5" {...props} />,
  li: (props) => <li className="mb-0.5" {...props} />,
  a: (props) => <a className={LINK_CLS} target="_blank" rel="noreferrer" {...props} />,
  pre: (props) => (
    <pre className="mb-2 overflow-x-auto rounded-lg bg-black/80 p-3 chat-text-sm text-white dark:bg-black/60" {...props} />
  ),
  // A GFM table is sized by its own columns and can't shrink to the bubble, so it gets its own
  // horizontal scroller — the same escape hatch a code block has — instead of spilling out the side.
  table: (props) => (
    <div className="mb-2 max-w-full overflow-x-auto">
      <table className="w-max border-collapse" {...props} />
    </div>
  ),
  th: (props) => <th className="border border-black/15 px-2 py-1 text-left dark:border-white/20" {...props} />,
  td: (props) => <td className="border border-black/15 px-2 py-1 dark:border-white/20" {...props} />,
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

// Pull every markdown image out of an assistant reply, in document order, so a tapped image can open
// as a gallery of all images in the same bubble (mirroring how a user message's images open). Matches
// `![alt](url)` and `![alt](url "title")`; the URL is the first non-space token after `(` — exactly
// what react-markdown parses into an <img>'s `src`, so the tapped image lines up by src. Angle-bracketed
// or space-containing URLs (rare for web images) simply won't match here, in which case the img renderer
// falls back to opening just the tapped image — zoom still works either way.
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(\s*([^)\s]+)/g;
function extractMarkdownImages(text: string): LightboxImage[] {
  const out: LightboxImage[] = [];
  for (const m of text.matchAll(MARKDOWN_IMAGE_RE)) out.push({ src: m[2], alt: m[1] });
  return out;
}

// react-markdown's default URL sanitizer strips `data:` URLs, which would make an inline (base64)
// image the assistant embeds vanish entirely. Inline image data is safe to render, so let those
// through while keeping the default protection for every other URL (links, http/https, etc.).
function allowInlineImages(url: string): string {
  return /^data:image\//i.test(url) ? url : defaultUrlTransform(url);
}

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
    <span className="flex h-[1em] items-center gap-0.5" aria-hidden="true">
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
  generatingAudioIds,
  onReply,
  onDelete,
  onSendFile,
  onForget,
  scale,
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
  /** Ids of text replies whose spoken audio is being synthesized on demand (tapped "Play", no clip
   *  yet) — drives the button's loading state until the clip lands. */
  generatingAudioIds: ReadonlySet<string>;
  /** Start composing a reply that quotes this message. */
  onReply: (m: ChatMessage) => void;
  /** Remove a message from the chat (via the long-press / right-click menu). */
  onDelete: (m: ChatMessage) => void;
  /** Confirm a "fileOffer" card: fetch the stored file back and turn that card into a real message
   *  carrying the file. Nothing reaches the chat until this runs — tapping the confirm button *is*
   *  the send. */
  onSendFile: (messageId: string, fileId: number) => void;
  /** Confirm a "forgetOffer" card: permanently remove the listed items and replace the card with a
   *  short confirmation. Nothing is deleted until this runs — tapping the button *is* the deletion. */
  onForget: (messageId: string, items: ForgetItem[]) => void;
  /** The user's chat text size (1 = 100%), set from the mobile header's A− / % / A+ control. */
  scale: number;
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

  // Tapping an image bubble opens it full screen (see ImageLightbox). A bubble's images open as a
  // gallery, starting at the tapped one.
  const [lightbox, setLightbox] = useState<{ images: LightboxImage[]; index: number } | null>(null);
  const openLightbox = useCallback(
    (images: LightboxImage[], index: number) => setLightbox({ images, index }),
    [],
  );

  // Tapping a non-image attachment chip opens the same full-screen preview from either bubble (the
  // `Attachments` component below is shared by both sides), so the state lives here next to the
  // lightbox's and only one <FilePreview> is ever mounted.
  // The one exception is a PDF on iOS: WebKit renders an iframed PDF as a blank panel, so the tap
  // hands the file straight to the system viewer instead. That has to happen inside this handler —
  // i.e. still within the original tap — or Safari treats the navigation as unprompted and blocks it.
  const [preview, setPreview] = useState<PreparedFile | null>(null);
  const openFile = useCallback((f: PreparedFile) => {
    if (isIOS() && f.kind === "pdf") {
      openFileInNewTab(f);
      return;
    }
    setPreview(f);
  }, []);

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
    // The transcript is the one surface the user's text-size control scales: `chat-text` is the
    // anchor (the 14px the bubbles used to hard-code, times --chat-scale) and everything below
    // either inherits it or sizes itself in `em` against it. Chrome — the header, composer, call
    // bar, avatars, and the menu/lightbox overlays — keeps its own fixed sizes on purpose, so
    // bigger text buys reading area instead of eating it. The cast is required: @types/react has
    // no index signature for custom properties.
    <div
      className="chat-text mx-auto w-full max-w-3xl space-y-5 px-4 py-6"
      style={{ "--chat-scale": scale } as CSSProperties}
    >
      {messages.map((m) =>
        m.kind === "call" ? (
          // Centered system chip logged when a realtime call ends — shows how long it lasted.
          <div key={m.id} className="flex justify-center">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-black/5 px-3 py-1 chat-text-sm font-medium text-black/55 dark:bg-white/10 dark:text-white/55">
              <PhoneOff size={13} className="h-[1.08em] w-[1.08em]" aria-hidden="true" />
              {t.message.callEnded}
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">{formatDuration(m.durationSec ?? 0)}</span>
            </span>
          </div>
        ) : m.kind === "forgetOffer" && m.forgetRef ? (
          // The assistant found things it remembers and is asking before removing them. Tapping the
          // confirm button IS the deletion — nothing has been removed at the point this renders.
          <ForgetOfferCard
            key={m.id}
            note={m.text}
            items={m.forgetRef}
            onForget={() => onForget(m.id, m.forgetRef!)}
          />
        ) : m.kind === "fileOffer" && m.fileRef ? (
          // The assistant found a stored file and is asking before handing it over. Kept ahead of the
          // user/assistant split on purpose: an unhandled kind falls through to AssistantMessage and
          // would render as an empty bubble.
          <FileOfferCard
            key={m.id}
            note={m.text}
            file={m.fileRef}
            onSend={() => onSendFile(m.id, m.fileRef!.id)}
          />
        ) : m.role === "user" ? (
          <div
            key={m.id}
            id={`msg-${m.id}`}
            className={`flex items-start justify-end gap-3 ${rowFlashCls(flashId === m.id)}`}
          >
            <HoverReplyButton label={t.message.reply} onClick={() => onReply(m)} />
            <Pressable
              onOpen={(x, y) => openMenu(m, x, y)}
              className={`${BUBBLE_WRAP_CLS} max-w-[80%] rounded-2xl rounded-tr-sm bg-blue-600 px-4 py-2.5 text-white shadow-sm [-webkit-touch-callout:none] [@media(hover:none)]:select-none`}
            >
              {m.replyTo && <QuotedReply r={m.replyTo} onJump={jumpTo} />}
              {m.files && m.files.length > 0 && (
                <Attachments
                  files={m.files}
                  tone="user"
                  className={m.text || m.caption ? "mb-2" : ""}
                  onOpenImage={openLightbox}
                  onOpenFile={openFile}
                />
              )}
              {m.kind === "voice" ? (
                <>
                  {/* Typed and spoken in one bubble, in the order they were composed. The typed half
                      reads as ordinary message text; the mic icon below marks where the clip starts,
                      so it stays obvious which words were said rather than written. */}
                  {m.caption && (
                    <span className="mb-1.5 block whitespace-pre-wrap">{linkify(m.caption, LINK_CLS)}</span>
                  )}
                  {m.text ? (
                    <span className="flex items-start gap-1.5">
                      <Mic size={14} className="chat-icon mt-0.5 shrink-0 opacity-90" aria-hidden="true" />
                      <span className="min-w-0 whitespace-pre-wrap">{linkify(m.text, LINK_CLS)}</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 italic opacity-90">
                      <Mic size={14} className="chat-icon" aria-hidden="true" /> {t.message.voiceMessage}
                    </span>
                  )}
                </>
              ) : (
                <span className="whitespace-pre-wrap">{linkify(m.text, LINK_CLS)}</span>
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
            generating={generatingAudioIds.has(m.id)}
            onPlayAudio={onPlayAudio}
            onReveal={followReveal}
            onOpenMenu={openMenu}
            onOpenImage={openLightbox}
            onOpenFile={openFile}
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
          onDelete={() => {
            setMenu(null);
            onDelete(menu.m);
          }}
          onClose={() => setMenu(null)}
        />
      )}
      {lightbox && (
        <ImageLightbox
          images={lightbox.images}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
        />
      )}
      {/* Keyed on the file so opening a different attachment remounts it with its own object URL. */}
      {preview && <FilePreview key={preview.id} file={preview} onClose={() => setPreview(null)} />}
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
  generating,
  onPlayAudio,
  onReveal,
  onOpenMenu,
  onOpenImage,
  onOpenFile,
  onReply,
}: {
  m: ChatMessage;
  flashing: boolean;
  /** Playback state of this reply's spoken audio: idle, actively playing, or paused mid-clip. */
  audioState: "idle" | "playing" | "paused";
  /** True while this text reply's audio is being synthesized on demand (tapped "Play", no clip yet). */
  generating: boolean;
  onPlayAudio: (m: ChatMessage) => void;
  onReveal: () => void;
  onOpenMenu: (m: ChatMessage, x: number, y: number) => void;
  /** Open the full-screen viewer for an image the assistant embedded in its reply. */
  onOpenImage: (images: LightboxImage[], index: number) => void;
  /** Open the preview for a non-image file the assistant handed back. */
  onOpenFile: (f: PreparedFile) => void;
  onReply: (m: ChatMessage) => void;
}) {
  const t = useT();
  // Whether this reply mounted mid-stream, captured once at mount — history never animates.
  const [mountedStreaming] = useState(!!m.streaming);
  const text = useWordReveal(m.text, mountedStreaming && !m.error);

  // Markdown images the assistant embedded (`![alt](url)`) render as plain, un-tappable <img>s unless
  // we override the `img` renderer. Make each one open the same full-screen lightbox a user's own
  // images use — tapping opens a gallery of all images in this reply, starting at the tapped one.
  const galleryImages = useMemo(() => extractMarkdownImages(text), [text]);
  const mdComponents = useMemo<Components>(
    () => ({
      ...md,
      img: (props) => {
        const src = typeof props.src === "string" ? props.src : "";
        if (!src) return null;
        const alt = props.alt || t.message.imageAlt;
        const idx = galleryImages.findIndex((g) => g.src === src);
        const list = idx >= 0 ? galleryImages : [{ src, alt }];
        return (
          <button
            type="button"
            onClick={() => onOpenImage(list, idx >= 0 ? idx : 0)}
            aria-label={t.message.viewImage}
            className="my-1.5 block cursor-zoom-in overflow-hidden rounded-xl transition hover:opacity-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={alt} className="max-h-80 w-full object-contain" />
          </button>
        );
      },
    }),
    [galleryImages, onOpenImage, t],
  );
  const [typingDots, setTypingDots] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setTypingDots(true), TYPING_DELAY_MS);
    return () => clearTimeout(id);
  }, []);
  // Keep the view pinned to the bottom as words land.
  useEffect(() => {
    if (text) onReveal();
  }, [text, onReveal]);

  // A confirmed file offer becomes an assistant message whose whole content is the file — often with
  // no text at all. That reply is finished, not pending, so it must never fall into the dots below.
  const hasFiles = !!m.files?.length;

  // Whether to show the spoken-audio button under the bubble. A reply that already carries a clip
  // (a voice-message reply, or a text reply voiced on an earlier tap) plays it; a plain finished
  // text reply has none — it is never synthesized automatically (that would spend tokens on audio
  // nobody asked to hear), so its button synthesizes on demand the first time it's tapped. Excludes
  // errors, streaming/pending replies, the call chip and offer cards, and file-only bubbles.
  const canSpeakText =
    !!m.text.trim() &&
    !m.error &&
    !m.streaming &&
    !m.pendingAudio &&
    (m.kind === undefined || m.kind === "text" || m.kind === "voice");
  const showAudioButton = !!m.audio || canSpeakText;

  // While `pendingAudio` is set the text has streamed in but is deliberately withheld until the
  // spoken audio is ready — keep the bubble on the "typing"/speaking dots as if the reply is still
  // being prepared, so text never races ahead of the voice.
  if ((!text || m.pendingAudio) && !m.error && !hasFiles) {
    if (!typingDots) return null; // silent grace period — the reply may land before "typing" ever shows
    return (
      <div className="flex items-start gap-3">
        <AiAvatar />
        <div className={BUBBLE_CLS}>
          <span className="flex items-center gap-1 py-1" aria-label="Assistant is typing" role="status">
            <span className="h-[0.571em] w-[0.571em] animate-bounce rounded-full bg-black/40 [animation-delay:-0.3s] dark:bg-white/40" />
            <span className="h-[0.571em] w-[0.571em] animate-bounce rounded-full bg-black/40 [animation-delay:-0.15s] dark:bg-white/40" />
            <span className="h-[0.571em] w-[0.571em] animate-bounce rounded-full bg-black/40 dark:bg-white/40" />
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
        {text && (
          <div className={m.error ? "text-red-600 dark:text-red-400" : ""}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={allowInlineImages} components={mdComponents}>
              {text}
            </ReactMarkdown>
          </div>
        )}
        {/* A file the assistant handed back after the user confirmed an offer card — same chips,
            lightbox and preview as the user's own attachments, toned for the light bubble. */}
        {m.files && m.files.length > 0 && (
          <Attachments
            files={m.files}
            tone="assistant"
            className={text ? "mt-2" : ""}
            onOpenImage={onOpenImage}
            onOpenFile={onOpenFile}
          />
        )}
        {showAudioButton && (
          <button
            onClick={() => onPlayAudio(m)}
            disabled={generating}
            aria-label={
              generating
                ? t.message.generatingReply
                : audioState === "playing"
                  ? t.message.pauseReply
                  : audioState === "paused"
                    ? t.message.resumeReply
                    : t.message.playReply
            }
            className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-black/5 px-3 py-1 chat-text-sm font-medium transition hover:bg-black/10 disabled:hover:bg-black/5 dark:bg-white/10 dark:hover:bg-white/15 dark:disabled:hover:bg-white/10"
          >
            {generating ? (
              <>
                <Loader2 size={13} className="chat-icon animate-spin" aria-hidden="true" /> {t.message.generatingReply}
              </>
            ) : audioState === "playing" ? (
              <>
                <EqualizerBars /> {t.message.pauseReply}
              </>
            ) : audioState === "paused" ? (
              <>
                <Play size={13} className="chat-icon" /> {t.message.resumeReply}
              </>
            ) : (
              <>
                <Volume2 size={13} className="chat-icon" /> {t.message.playReply}
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
  // Set when a long press opened the menu, so the click some browsers still fire on release doesn't
  // also follow a link the finger happened to be resting on. Cleared by the next touch, so a plain
  // tap right after is never swallowed.
  const openedByPress = useRef(false);
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
      onClickCapture={(e) => {
        if (!openedByPress.current) return;
        openedByPress.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
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
        openedByPress.current = false;
        clear();
        timer.current = setTimeout(() => {
          timer.current = null;
          openedByPress.current = true;
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

/**
 * Attachments hanging off a bubble: images render inline and open the full-screen gallery of *this*
 * bubble's images, everything else is a name + size chip that opens the file preview. Shared by both
 * sides — the files a user sent, and a stored file the assistant handed back after a confirmed offer
 * — so both are tappable from one place, and the only difference is tone: translucent white on the
 * blue user bubble, tinted neutral on the assistant's light one.
 */
function Attachments({
  files,
  tone,
  className,
  onOpenImage,
  onOpenFile,
}: {
  files: PreparedFile[];
  /** Which bubble these sit in, which decides the chip and focus-ring colors. */
  tone: "user" | "assistant";
  /** Spacing against the bubble's text, which sits below on the user side and above on the assistant's. */
  className?: string;
  onOpenImage: (images: LightboxImage[], index: number) => void;
  /** Open the full-screen preview for a PDF / document / audio chip. */
  onOpenFile: (f: PreparedFile) => void;
}) {
  const t = useT();
  const user = tone === "user";
  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ""}`}>
      {files.map((f) =>
        f.kind === "image" ? (
          <button
            key={f.id}
            type="button"
            onClick={() => {
              const imgs = files.filter((x) => x.kind === "image");
              onOpenImage(
                imgs.map((x) => ({ src: `data:${x.mimeType};base64,${x.base64}`, alt: t.message.imageAlt })),
                imgs.findIndex((x) => x.id === f.id),
              );
            }}
            aria-label={t.message.viewImage}
            className={`block cursor-zoom-in overflow-hidden rounded-xl transition hover:opacity-95 focus:outline-none focus-visible:ring-2 ${
              user ? "focus-visible:ring-white/70" : "focus-visible:ring-blue-500/60"
            }`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`data:${f.mimeType};base64,${f.base64}`}
              alt={t.message.imageAlt}
              className="max-h-64 w-full object-contain"
            />
          </button>
        ) : (
          // A chip the user can tap to actually read the file (see FilePreview) — `text-left` because
          // a <button> would otherwise center the name and size the inner spans lay out as blocks.
          <button
            key={f.id}
            type="button"
            onClick={() => onOpenFile(f)}
            /* The name goes in the label too: a bare "Open file" would override the visible name and
               size, leaving a screen reader to announce every chip in a bubble identically. */
            aria-label={`${t.message.viewFile}: ${f.name}`}
            className={`flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-left transition focus:outline-none focus-visible:ring-2 ${
              user
                ? "bg-white/15 hover:bg-white/25 focus-visible:ring-white/70"
                : "bg-black/5 hover:bg-black/10 focus-visible:ring-blue-500/60 dark:bg-white/10 dark:hover:bg-white/15"
            }`}
          >
            {f.kind === "audio" ? (
              <FileAudio size={16} className={`h-[1.14em] w-[1.14em] shrink-0 ${user ? "opacity-90" : "opacity-55"}`} aria-hidden="true" />
            ) : (
              <FileText size={16} className={`h-[1.14em] w-[1.14em] shrink-0 ${user ? "opacity-90" : "opacity-55"}`} aria-hidden="true" />
            )}
            <span className="min-w-0">
              <span className="block truncate chat-text-sm font-medium" title={f.name}>{f.name}</span>
              <span className={`block chat-text-2xs ${user ? "opacity-75" : "text-black/45 dark:text-white/45"}`}>
                {formatSize(f.size)}
              </span>
            </span>
          </button>
        ),
      )}
    </div>
  );
}

/** The icon that stands in for a stored file on the offer card, by what kind of file it is. */
const FILE_KIND_ICONS = {
  image: ImageIcon,
  audio: FileAudio,
  pdf: FileText,
  text: FileText,
} as const;

/**
 * The confirmation card the assistant posts when `send_file` finds a file the user asked for. Nothing
 * has been sent yet: the card names the file and waits: confirming hands it to `onSendFile`, which
 * fetches the bytes back and replaces this card with a real message carrying the file; **Not now**
 * just drops the card. Styled as an assistant bubble (avatar, same chrome) so it reads as EverVault
 * holding something out rather than a system notice. The confirm button carries a downward arrow, not
 * the composer's paper plane: the file is coming *to* the user, and the plane read as sending it away.
 */
function FileOfferCard({
  note,
  file,
  onSend,
}: {
  /** The model's short line about the file, shown above it when it wrote one. */
  note: string;
  file: StoredFileMeta;
  onSend: () => void;
}) {
  const t = useT();
  const [dismissed, setDismissed] = useState(false);
  // Set on tap and never cleared: the caller owns the round-trip and replaces this message with the
  // delivered file (or an error) as soon as it settles, so the card unmounts either way. The spinner
  // only has to outlive the fetch — a 10MB PDF is not instant — not the card.
  const [sending, setSending] = useState(false);
  if (dismissed) return null;

  const Icon = FILE_KIND_ICONS[file.kind];
  return (
    <div className="flex items-start gap-3">
      <AiAvatar />
      <div className={BUBBLE_CLS}>
        <div className="flex items-center gap-1.5 chat-text-sm font-semibold text-black/50 dark:text-white/50">
          <Paperclip size={13} className="chat-icon" aria-hidden="true" />
          {t.message.fileOffer}
        </div>
        {note && <p className="mt-1.5 whitespace-pre-wrap">{note}</p>}
        <div className="mt-2 flex items-center gap-2.5 rounded-xl bg-black/5 px-3 py-2.5 dark:bg-white/10">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-black/55 shadow-sm dark:bg-white/10 dark:text-white/60">
            <Icon size={17} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate chat-text-sm font-medium" title={file.name}>{file.name}</span>
            <span className="block chat-text-2xs text-black/45 dark:text-white/45">
              {formatSize(file.sizeBytes)} <span aria-hidden="true">·</span> {formatMemoryDate(file.createdAt)}
            </span>
          </span>
        </div>
        <div className="mt-2.5 flex items-center gap-1.5">
          <button
            type="button"
            disabled={sending}
            onClick={() => {
              setSending(true);
              onSend();
            }}
            className="inline-flex items-center gap-1.5 rounded-full bg-blue-600 px-3.5 py-1.5 chat-text-sm font-medium text-white shadow-sm transition hover:bg-blue-700 disabled:opacity-60"
          >
            {sending ? <Loader2 size={13} className="chat-icon animate-spin" aria-hidden="true" /> : <ArrowDownToLine size={13} className="chat-icon" aria-hidden="true" />}
            {t.message.sendFile}
          </button>
          <button
            type="button"
            disabled={sending}
            onClick={() => setDismissed(true)}
            className="rounded-full px-3 py-1.5 chat-text-sm font-medium text-black/55 transition hover:bg-black/5 disabled:opacity-40 dark:text-white/55 dark:hover:bg-white/10"
          >
            {t.message.notNow}
          </button>
        </div>
      </div>
    </div>
  );
}

// The assistant has found things it remembers and is asking whether to remove them. Deliberately
// modelled on FileOfferCard: the model can propose, but only the human can act. Removal is permanent,
// so the list shows exactly what would go and the destructive button is styled as such.
function ForgetOfferCard({
  note,
  items,
  onForget,
}: {
  note: string;
  items: ForgetItem[];
  onForget: () => void;
}) {
  const t = useT();
  const [dismissed, setDismissed] = useState(false);
  // Set on tap and never cleared: the caller replaces this message once the deletes settle, so the
  // card unmounts either way. The spinner only has to outlive the round-trip.
  const [working, setWorking] = useState(false);
  if (dismissed) return null;

  return (
    <div className="flex items-start gap-3">
      <AiAvatar />
      <div className={BUBBLE_CLS}>
        <div className="flex items-center gap-1.5 chat-text-sm font-semibold text-black/50 dark:text-white/50">
          <Eraser size={13} className="chat-icon" aria-hidden="true" />
          {t.message.forgetOffer}
        </div>
        {note && <p className="mt-1.5 whitespace-pre-wrap">{note}</p>}
        <ul className="mt-2 flex flex-col gap-1.5">
          {items.map((it) => (
            <li
              key={it.ref}
              className="rounded-xl bg-black/5 px-3 py-2 chat-text-sm dark:bg-white/10"
            >
              <span className="block">{it.what}</span>
              {it.detail && (
                <span className="mt-0.5 block chat-text-2xs text-black/45 dark:text-white/45">{it.detail}</span>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-2 chat-text-2xs text-black/45 dark:text-white/45">{t.message.forgetPermanent}</p>
        <div className="mt-2.5 flex items-center gap-1.5">
          <button
            type="button"
            disabled={working}
            onClick={() => {
              setWorking(true);
              onForget();
            }}
            className="inline-flex items-center gap-1.5 rounded-full bg-red-600 px-3.5 py-1.5 chat-text-sm font-medium text-white shadow-sm transition hover:bg-red-700 disabled:opacity-60"
          >
            {working ? (
              <Loader2 size={13} className="chat-icon animate-spin" aria-hidden="true" />
            ) : (
              <Eraser size={13} className="chat-icon" aria-hidden="true" />
            )}
            {t.message.forgetConfirm}
          </button>
          <button
            type="button"
            disabled={working}
            onClick={() => setDismissed(true)}
            className="rounded-full px-3 py-1.5 chat-text-sm font-medium text-black/55 transition hover:bg-black/5 disabled:opacity-40 dark:text-white/55 dark:hover:bg-white/10"
          >
            {t.message.notNow}
          </button>
        </div>
      </div>
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
      <span className="block chat-text-xs font-semibold text-white/95">
        {r.role === "user" ? t.message.you : t.message.assistantName}
      </span>
      <span className="line-clamp-2 block chat-text-sm text-white/80">{r.text || t.message.voiceMessage}</span>
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

// Keeps a bubble's content inside the bubble. A pasted URL, a long file name or any other
// unbroken run of characters is a single "word" the browser will happily paint past the padding
// (and, on the user side, past the avatar and off the screen) — `break-words` lets it wrap
// mid-word when it has no other way to fit. `min-w-0` is the flex half of the same fix: without
// it a row flex item refuses to shrink below its content's minimum width, so max-w-[80%] alone
// would not hold. Applies to every bubble, since both sides can carry pasted text.
const BUBBLE_WRAP_CLS = "min-w-0 break-words";

const BUBBLE_CLS =
  `${BUBBLE_WRAP_CLS} max-w-[80%] rounded-2xl rounded-tl-sm border border-black/10 bg-white px-4 py-2.5 shadow-sm dark:border-white/10 dark:bg-neutral-900`;
