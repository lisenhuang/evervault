"use client";

import { useEffect, useRef, useState } from "react";
import { FileAudio, FileText, FileUp, Loader2, Mic, Paperclip, Phone, Reply, Send, X } from "lucide-react";
import { useT } from "@/i18n/LanguageProvider";
import { FILE_ACCEPT, FileError, formatSize, inlineSize, MAX_FILES, MAX_TOTAL_INLINE, prepareFile, type PreparedFile } from "./lib/files";
import type { ChatMessage } from "./types";

export type VoiceState = "idle" | "recording" | "processing";

// A voice recording runs for at most this many seconds; the mic button counts down and,
// on reaching 0, stops-and-sends automatically (same as tapping the button).
const RECORD_LIMIT = 99;

export default function Composer({
  onSendText,
  onStartVoice,
  onStopVoice,
  onStartCall,
  voiceState,
  inCall,
  replyTo,
  onCancelReply,
}: {
  onSendText: (text: string, files?: PreparedFile[]) => void;
  onStartVoice: () => void;
  onStopVoice: () => void;
  onStartCall: () => void;
  voiceState: VoiceState;
  /** A realtime voice call is active. The call owns the mic, so recording a voice message and
   *  starting another call are blocked while it runs — but typing/attaching/sending text is not:
   *  a text turn has no audio, so it can be queued alongside the call. */
  inCall: boolean;
  /** The message the next send will quote (from the message menu's "Reply"). */
  replyTo: ChatMessage | null;
  onCancelReply: () => void;
}) {
  const t = useT();
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  // Up to MAX_FILES attachments per message (picker, paste, or drag-and-drop).
  const [files, setFiles] = useState<PreparedFile[]>([]);
  const [busyCount, setBusyCount] = useState(0);
  const [attachError, setAttachError] = useState("");
  const [dragging, setDragging] = useState(false);
  // On touch devices (phones/tablets) Enter should insert a newline like a
  // messaging app; the send button is used to send. On desktop, Enter sends.
  const [isTouch, setIsTouch] = useState(false);
  // Phone-width screens get a short input placeholder — the full one gets clipped.
  const [isNarrow, setIsNarrow] = useState(false);
  // Seconds left in the current recording, shown counting down inside the mic button.
  const [recordLeft, setRecordLeft] = useState(RECORD_LIMIT);
  // Guards the auto-send so hitting 0 stops-and-sends exactly once per recording.
  const autoSentRef = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Ref mirrors so slot accounting stays exact across concurrent async preparations, and so the
  // window-level drag handlers (bound once) always call the latest attachFiles.
  const filesRef = useRef<PreparedFile[]>([]);
  const inflightRef = useRef(0);
  const dragDepthRef = useRef(0);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attachFilesRef = useRef<(incoming: File[]) => void>(() => {});

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(hover: none) and (pointer: coarse)");
    const update = () => setIsTouch(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(max-width: 640px)");
    const update = () => setIsNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Picking "Reply" moves the user straight into typing the reply.
  useEffect(() => {
    if (replyTo) taRef.current?.focus();
  }, [replyTo]);

  // Recording countdown: tick down once a second while recording; reset whenever we're not.
  useEffect(() => {
    if (voiceState !== "recording") {
      setRecordLeft(RECORD_LIMIT);
      autoSentRef.current = false;
      return;
    }
    const id = setInterval(() => setRecordLeft((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(id);
  }, [voiceState]);

  // Hitting 0 while still recording stops-and-sends automatically (once).
  useEffect(() => {
    if (voiceState === "recording" && recordLeft === 0 && !autoSentRef.current) {
      autoSentRef.current = true;
      onStopVoice();
    }
  }, [voiceState, recordLeft, onStopVoice]);

  function setFilesSync(next: PreparedFile[]) {
    filesRef.current = next;
    setFiles(next);
  }

  function flashError(msg: string) {
    setAttachError(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setAttachError(""), 5000);
  }
  useEffect(() => () => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
  }, []);

  function attachErrorMessage(e: unknown, fallbackName: string): string {
    const name = e instanceof FileError ? e.fileName : fallbackName;
    const code = e instanceof FileError ? e.code : "unreadable";
    switch (code) {
      case "too-large":
        return t.composer.fileTooLarge(name);
      case "legacy-doc":
        return t.composer.fileLegacyDoc(name);
      case "unsupported":
        return t.composer.fileUnsupported(name);
      default:
        return t.composer.fileUnreadable(name);
    }
  }

  async function attachFiles(incoming: File[]) {
    if (!incoming.length || voiceState === "recording") return;
    const room = MAX_FILES - filesRef.current.length - inflightRef.current;
    if (incoming.length > room) flashError(t.composer.tooManyFiles(MAX_FILES));
    if (room <= 0) return;
    const batch = incoming.slice(0, room);
    inflightRef.current += batch.length;
    setBusyCount((c) => c + batch.length);
    await Promise.all(
      batch.map(async (file) => {
        try {
          const prepared = await prepareFile(file);
          // Keep the combined payload sendable: everything attached is inlined into the request.
          const used = filesRef.current.reduce((sum, x) => sum + inlineSize(x), 0);
          if (used + inlineSize(prepared) > MAX_TOTAL_INLINE) {
            flashError(t.composer.filesTooLargeTotal);
            return;
          }
          setFilesSync([...filesRef.current, prepared]);
        } catch (e) {
          flashError(attachErrorMessage(e, file.name));
        } finally {
          inflightRef.current -= 1;
          setBusyCount((c) => c - 1);
        }
      }),
    );
  }
  useEffect(() => {
    attachFilesRef.current = (incoming) => void attachFiles(incoming);
  });

  // Whole-window drag-and-drop: dragging files anywhere over the page shows the drop overlay and
  // dropping attaches them. The depth counter absorbs the enter/leave churn of crossing children.
  useEffect(() => {
    const hasDragFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onDragEnter = (e: DragEvent) => {
      if (!hasDragFiles(e)) return;
      e.preventDefault();
      dragDepthRef.current += 1;
      setDragging(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasDragFiles(e)) return;
      e.preventDefault(); // required, or the browser navigates to the dropped file
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasDragFiles(e)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasDragFiles(e)) return;
      e.preventDefault();
      dragDepthRef.current = 0;
      setDragging(false);
      const dropped = Array.from(e.dataTransfer?.files ?? []);
      if (dropped.length) attachFilesRef.current(dropped);
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  function grow() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }

  function send() {
    const trimmed = text.trim();
    if ((!trimmed && files.length === 0) || busyCount > 0) return;
    onSendText(trimmed, files.length ? files : undefined);
    setText("");
    setFilesSync([]);
    requestAnimationFrame(grow);
  }

  function attachClick() {
    // The single combined picker accepts images and documents; on iOS the OS itself surfaces the
    // Photo Library / Take Photo / Choose Files choice, so no in-app menu is needed.
    fileInputRef.current?.click();
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-picking the same file
    if (picked.length) void attachFiles(picked);
  }

  function micClick() {
    if (voiceState === "recording") onStopVoice();
    else if (voiceState === "idle") onStartVoice();
  }

  function callClick() {
    onStartCall();
  }

  const recording = voiceState === "recording";
  const processing = voiceState === "processing";
  const busy = busyCount > 0;

  return (
    <div className="border-t border-black/10 bg-white/80 pb-[env(safe-area-inset-bottom)] backdrop-blur dark:border-white/10 dark:bg-neutral-950/80">
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px]">
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-white/80 bg-white/10 px-10 py-8 text-white shadow-lg">
            <FileUp size={28} aria-hidden="true" />
            <span className="text-sm font-medium">{t.composer.dropFiles}</span>
          </div>
        </div>
      )}
      <div className="mx-auto w-full max-w-3xl px-4 py-3">
        {recording && (
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-red-600 dark:text-red-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-red-600 dark:bg-red-400" />
            {t.composer.recording}
          </div>
        )}
        {attachError && (
          <div className="mb-2 text-xs font-medium text-red-600 dark:text-red-400">{attachError}</div>
        )}
        {replyTo && (
          <div className="mb-2 flex items-center gap-2.5 rounded-xl border border-black/10 bg-black/4 py-2 pr-1.5 pl-3 dark:border-white/10 dark:bg-white/6">
            <Reply size={16} className="shrink-0 text-blue-600 dark:text-blue-400" aria-hidden="true" />
            <div className="min-w-0 flex-1 border-l-2 border-blue-600/60 pl-2.5 dark:border-blue-400/60">
              <div className="text-xs font-semibold text-blue-700 dark:text-blue-300">
                {t.message.replyingTo(replyTo.role === "user" ? t.message.you : t.message.assistantName)}
              </div>
              <div className="truncate text-xs text-black/60 dark:text-white/60">
                {replyTo.text || t.message.voiceMessage}
              </div>
            </div>
            <button
              onClick={onCancelReply}
              title={t.message.cancelReply}
              aria-label={t.message.cancelReply}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-black/45 transition hover:bg-black/5 hover:text-black/70 dark:text-white/45 dark:hover:bg-white/10 dark:hover:text-white/70"
            >
              <X size={15} />
            </button>
          </div>
        )}
        {(files.length > 0 || busy) && (
          <div className="mb-2 flex flex-wrap items-start gap-2">
            {files.map((f) =>
              f.kind === "image" ? (
                <div key={f.id} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={f.dataUrl}
                    alt={t.composer.attachedImage}
                    className="h-20 w-20 rounded-xl border border-black/10 object-cover shadow-sm dark:border-white/15"
                  />
                  <RemoveButton label={t.composer.removeFile} onClick={() => setFilesSync(filesRef.current.filter((x) => x.id !== f.id))} />
                </div>
              ) : (
                <div
                  key={f.id}
                  className="relative flex h-20 w-40 flex-col justify-between rounded-xl border border-black/10 bg-black/5 p-2.5 dark:border-white/15 dark:bg-white/10"
                >
                  {f.kind === "audio" ? (
                    <FileAudio size={18} className="text-black/50 dark:text-white/50" aria-hidden="true" />
                  ) : (
                    <FileText size={18} className="text-black/50 dark:text-white/50" aria-hidden="true" />
                  )}
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium" title={f.name}>{f.name}</div>
                    <div className="text-[10px] text-black/45 dark:text-white/45">{formatSize(f.size)}</div>
                  </div>
                  <RemoveButton label={t.composer.removeFile} onClick={() => setFilesSync(filesRef.current.filter((x) => x.id !== f.id))} />
                </div>
              ),
            )}
            {Array.from({ length: busyCount }).map((_, i) => (
              <div
                key={`busy-${i}`}
                className="flex h-20 w-20 items-center justify-center rounded-xl border border-black/10 bg-black/5 dark:border-white/15 dark:bg-white/10"
              >
                <Loader2 size={18} className="animate-spin text-black/40 dark:text-white/40" />
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={callClick}
            disabled={recording || processing || inCall}
            title={inCall ? t.composer.callInProgress : t.composer.startCall}
            className={`${focused ? "hidden md:flex" : "flex"} h-11 w-11 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-emerald-500 to-teal-600 text-white shadow-sm transition hover:opacity-90 disabled:opacity-40`}
          >
            <Phone size={18} />
          </button>
          <button
            onClick={micClick}
            disabled={processing || inCall}
            title={recording ? t.composer.stopRecording : t.composer.recordVoice}
            className={`${focused ? "hidden md:flex" : "flex"} h-11 w-11 shrink-0 items-center justify-center rounded-full transition disabled:opacity-40 ${
              recording
                ? "bg-red-600 text-white hover:bg-red-700"
                : "border border-black/15 hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
            }`}
          >
            {processing ? (
              <Loader2 size={18} className="animate-spin" />
            ) : recording ? (
              // Fixed w/h keeps the circle from reshaping as the digit count changes; tabular-nums
              // keeps the number from shifting as it counts down. Tapping still stops-and-sends.
              <span className="text-sm font-semibold leading-none tabular-nums">{recordLeft}</span>
            ) : (
              <Mic size={18} />
            )}
          </button>

          <div className="relative flex flex-1 rounded-2xl border border-black/15 bg-white px-2 py-1.5 dark:border-white/20 dark:bg-neutral-900">
            <input ref={fileInputRef} type="file" accept={FILE_ACCEPT} multiple className="hidden" onChange={onPick} />
            <button
              onClick={attachClick}
              disabled={recording}
              title={t.composer.attachFiles}
              aria-label={t.composer.attachFiles}
              className="absolute left-2 top-1.5 flex h-8 w-8 items-center justify-center rounded-full text-black/50 transition hover:bg-black/5 disabled:opacity-40 dark:text-white/50 dark:hover:bg-white/10"
            >
              <Paperclip size={18} />
            </button>
            <textarea
              ref={taRef}
              value={text}
              rows={1}
              disabled={recording}
              placeholder={
                recording ? t.composer.listening : isNarrow ? t.composer.placeholderShort : t.composer.placeholder
              }
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onChange={(e) => {
                setText(e.target.value);
                grow();
              }}
              onPaste={(e) => {
                const pasted = Array.from(e.clipboardData?.items ?? [])
                  .filter((i) => i.kind === "file")
                  .map((i) => i.getAsFile())
                  .filter((f): f is File => !!f);
                if (pasted.length) {
                  e.preventDefault();
                  void attachFiles(pasted);
                }
              }}
              onKeyDown={(e) => {
                // On touch devices, let Enter insert a newline (default behavior).
                if (e.key === "Enter" && !e.shiftKey && !isTouch) {
                  e.preventDefault();
                  send();
                } else if (e.key === "Escape" && replyTo) {
                  onCancelReply();
                }
              }}
              className="max-h-40 flex-1 resize-none bg-transparent px-1 py-1.5 text-base outline-none [text-indent:2rem] md:text-sm disabled:opacity-50"
            />
          </div>

          <button
            onClick={send}
            disabled={recording || busy || (!text.trim() && files.length === 0)}
            title={t.composer.send}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition hover:bg-blue-700 disabled:opacity-40"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-white shadow-sm transition hover:bg-black dark:bg-white/80 dark:text-black dark:hover:bg-white"
    >
      <X size={12} />
    </button>
  );
}
