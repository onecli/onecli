"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, FileText, Loader2, Paperclip, Square, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { Textarea } from "@onecli/ui/components/textarea";
import { cn } from "@onecli/ui/lib/utils";
import { TURN_MESSAGE_MAX_LENGTH } from "@onecli/api/validations/conversation";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "@onecli/api/validations/attachments";
import type { AttachmentMeta } from "@/lib/api/types";
import type {
  OutgoingAttachment,
  OutgoingMessage,
} from "@/hooks/use-conversations";

/**
 * Deliberately availability-blind: the server queues a turn in every state
 * (§3.18 rule 3 — configuration never blocks conversation), and the offline
 * banner already carries that story. Send never yields to an in-flight turn
 * either — a mid-run message is accepted as a follow-up that steers into the
 * live run — so while a turn is active BOTH buttons render: Stop beside Send.
 *
 * Attachments stage HERE (each file uploads as soon as it is picked/pasted/
 * dropped, so Send is instant) and ride the send as ids; the composer stays
 * presentational — the section injects `uploadFile`, keeping this component
 * testable with a stub.
 */

/** One staged file: local identity + upload lifecycle. */
interface StagedAttachment {
  key: number;
  name: string;
  sizeBytes: number;
  status: "uploading" | "ready" | "failed";
  /** Server row, once the upload lands. */
  meta?: AttachmentMeta;
  /** Local preview for image files (also reused by the optimistic bubble). */
  objectUrl?: string;
  error?: string;
}

interface ComposerProps {
  onSend: (outgoing: OutgoingMessage) => void;
  /** Upload one picked file — injected so this component stays presentational. */
  uploadFile: (file: File) => Promise<AttachmentMeta>;
  sendPending: boolean;
  /** The send refusal (the follow-up cap is the one 4xx left), inline. */
  sendError: Error | null;
  /** The message a failed send carried — restored so the draft isn't lost. */
  failedDraft?: string;
  /** The attachments a failed send carried — still `pending` server-side, so
   * they restage as ready instead of being silently lost with the draft. */
  failedAttachments?: OutgoingAttachment[];
  /** Present while a turn is in flight: Stop renders BESIDE Send. */
  onStop?: () => void;
  stopPending?: boolean;
  autoFocus?: boolean;
  /** A first message to open with (the onboarding greeting). Applied once, on
   * mount, with the caret parked at its end — a later change must never
   * overwrite words the user is typing. */
  initialDraft?: string;
  className?: string;
}

const formatSize = (bytes: number): string =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))}KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

/** A local image preview, or nothing — never a throw (jsdom and old engines
 * lack `URL.createObjectURL`; a missing preview degrades to the file chip). */
const previewUrl = (file: File): string | undefined => {
  if (!file.type.startsWith("image/")) return undefined;
  try {
    return URL.createObjectURL(file);
  } catch {
    return undefined;
  }
};

let nextKey = 1;

export const Composer = ({
  onSend,
  uploadFile,
  sendPending,
  sendError,
  failedDraft,
  failedAttachments,
  onStop,
  stopPending = false,
  autoFocus = false,
  initialDraft,
  className,
}: ComposerProps) => {
  // Initial state, not an effect: the draft is there on the first paint, so
  // the field never flashes empty and a re-render can't resurrect it after
  // the user clears it.
  const [message, setMessage] = useState(initialDraft ?? "");
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Read by `stageFiles` for the room check — it must not compute capacity
   * inside a state updater (see its header). */
  const stagedRef = useRef<StagedAttachment[]>(staged);
  stagedRef.current = staged;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** The caret is parked exactly once — a later `initialDraft` change must not
   * yank the caret out from under someone who is already typing. */
  const draftPlacedRef = useRef(false);

  // A prefilled field opens with the caret at its END — Enter sends it,
  // backspace edits it. Never a selection: selected text is one keystroke
  // from being gone. (Same behavior as the onboarding name field.)
  useEffect(() => {
    if (!initialDraft || draftPlacedRef.current) return;
    const el = textareaRef.current;
    if (!el) return;
    draftPlacedRef.current = true;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [initialDraft]);

  // The field clears optimistically at submit; if that send then fails, put
  // the words back (unless the user already started typing something new).
  useEffect(() => {
    if (failedDraft !== undefined) {
      setMessage((current) => (current === "" ? failedDraft : current));
    }
  }, [failedDraft]);

  // Same restore for the files: a refused send's uploads are still pending
  // rows server-side — restage them as ready rather than losing them.
  useEffect(() => {
    if (!failedAttachments || failedAttachments.length === 0) return;
    setStaged((current) =>
      current.length > 0
        ? current
        : failedAttachments.map((attachment) => ({
            key: nextKey++,
            name: attachment.name,
            sizeBytes: attachment.sizeBytes,
            status: "ready" as const,
            meta: attachment,
            objectUrl: attachment.objectUrl,
          })),
    );
  }, [failedAttachments]);

  /**
   * Stage picked/pasted/dropped files. Every side effect — the upload call,
   * the toasts, the object URLs, the key counter — happens OUT HERE, never
   * inside a `setStaged` updater: React may invoke an updater more than once
   * (StrictMode does, and Next's dev default is StrictMode), which would fire
   * a second upload per file. The updater below is pure.
   */
  const stageFiles = (files: Iterable<File>) => {
    const incoming = [...files];
    if (incoming.length === 0) return;

    const room = MAX_ATTACHMENTS_PER_MESSAGE - stagedRef.current.length;
    if (incoming.length > room) {
      toast.error(
        `A message can carry at most ${MAX_ATTACHMENTS_PER_MESSAGE} files.`,
      );
    }

    const accepted: StagedAttachment[] = [];
    for (const file of incoming.slice(0, Math.max(0, room))) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        toast.error(
          `"${file.name}" is over the ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB limit.`,
        );
        continue;
      }
      if (file.size === 0) {
        toast.error(`"${file.name}" is empty.`);
        continue;
      }
      const entry: StagedAttachment = {
        key: nextKey++,
        name: file.name || "file",
        sizeBytes: file.size,
        status: "uploading",
        objectUrl: previewUrl(file),
      };
      accepted.push(entry);
      void uploadFile(file)
        .then((meta) =>
          setStaged((entries) =>
            entries.map((e) =>
              e.key === entry.key ? { ...e, status: "ready", meta } : e,
            ),
          ),
        )
        .catch((error: unknown) =>
          setStaged((entries) =>
            entries.map((e) =>
              e.key === entry.key
                ? {
                    ...e,
                    status: "failed",
                    error:
                      error instanceof Error ? error.message : "Upload failed",
                  }
                : e,
            ),
          ),
        );
    }
    if (accepted.length > 0) setStaged((current) => [...current, ...accepted]);
  };

  const removeStaged = (key: number) => {
    setStaged((entries) => {
      const entry = entries.find((e) => e.key === key);
      if (entry?.objectUrl) URL.revokeObjectURL(entry.objectUrl);
      return entries.filter((e) => e.key !== key);
    });
  };

  const ready = staged.filter(
    (e): e is StagedAttachment & { meta: AttachmentMeta } =>
      e.status === "ready" && e.meta !== undefined,
  );
  const uploading = staged.some((e) => e.status === "uploading");

  const trimmed = message.trim();
  const sendable =
    !sendPending &&
    !uploading &&
    (trimmed.length > 0 || ready.length > 0) &&
    message.length <= TURN_MESSAGE_MAX_LENGTH;

  const submit = () => {
    if (!sendable) return;
    // Say so rather than swallowing it: a failed upload cannot ride the send,
    // and dropping its chip silently would look like the file went along.
    const dropped = staged.filter((e) => e.status === "failed");
    if (dropped.length > 0) {
      toast.error(
        dropped.length === 1
          ? `"${dropped[0]?.name}" didn't upload and wasn't sent.`
          : `${dropped.length} files didn't upload and weren't sent.`,
      );
    }
    onSend({
      message: trimmed,
      attachments: ready.map((e) => ({ ...e.meta, objectUrl: e.objectUrl })),
    });
    setMessage("");
    // Object URLs of SENT images are handed to the optimistic bubble, so only
    // the unsent ones are revoked here (the sent ones are released when the
    // settled row replaces the pending one).
    for (const e of staged) {
      if (e.status !== "ready" && e.objectUrl) URL.revokeObjectURL(e.objectUrl);
    }
    setStaged([]);
  };

  return (
    <div className={cn("shrink-0 border-t p-3", className)}>
      {staged.length > 0 && (
        <div className="mx-auto mb-2 flex w-full max-w-3xl flex-wrap gap-2">
          {staged.map((entry) => (
            <div
              key={entry.key}
              className={cn(
                "flex items-center gap-2 rounded-md border px-2 py-1 text-xs",
                entry.status === "failed" &&
                  "border-destructive/50 text-destructive",
              )}
            >
              {entry.status === "uploading" ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : entry.objectUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={entry.objectUrl}
                  alt=""
                  className="size-6 rounded-sm object-cover"
                />
              ) : (
                <FileText className="size-3.5" aria-hidden />
              )}
              <span className="max-w-40 truncate" title={entry.name}>
                {entry.name}
              </span>
              <span
                className={cn(
                  // The failure REASON keeps the chip's destructive colour —
                  // muting it would read as de-emphasized metadata.
                  entry.status === "failed"
                    ? "font-medium"
                    : "text-muted-foreground",
                )}
              >
                {entry.status === "failed"
                  ? (entry.error ?? "Upload failed")
                  : formatSize(entry.sizeBytes)}
              </span>
              <button
                type="button"
                onClick={() => removeStaged(entry.key)}
                aria-label={`Remove ${entry.name}`}
                // -m-1 p-1: a 24px target (WCAG 2.5.8) without changing the
                // chip's visual density.
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring -m-1 rounded p-1 focus-visible:ring-2 focus-visible:outline-none"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      {/* Uploads are otherwise silent for a screen reader: the spinner is
          decorative and Send simply stops responding. */}
      <p aria-live="polite" className="sr-only">
        {uploading
          ? "Uploading attachment…"
          : staged.length > 0
            ? `${ready.length} attachment${ready.length === 1 ? "" : "s"} ready to send`
            : ""}
      </p>
      <div
        className={cn(
          "mx-auto flex w-full max-w-3xl items-end gap-2 rounded-md",
          dragOver && "ring-primary/40 ring-2",
        )}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        // Only a leave that actually exits the row counts — without the
        // containment check the ring flickers as the pointer crosses the
        // textarea and buttons inside it.
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setDragOver(false);
          }
        }}
        onDrop={(e) => {
          if (e.dataTransfer.files.length === 0) return;
          e.preventDefault();
          setDragOver(false);
          stageFiles(e.dataTransfer.files);
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          aria-hidden
          tabIndex={-1}
          onChange={(e) => {
            if (e.target.files) stageFiles(e.target.files);
            // Re-picking the same file must re-fire onChange.
            e.target.value = "";
          }}
        />
        <Button
          variant="ghost"
          size="icon"
          onClick={() => fileInputRef.current?.click()}
          disabled={staged.length >= MAX_ATTACHMENTS_PER_MESSAGE}
          aria-label="Attach files"
        >
          <Paperclip className="size-4" />
        </Button>
        <Textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              submit();
            }
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length > 0) {
              e.preventDefault();
              stageFiles(files);
            }
          }}
          placeholder="Message your agent…"
          aria-label="Message"
          autoFocus={autoFocus}
          rows={1}
          className="field-sizing-content max-h-40 min-h-9 resize-none"
        />
        {onStop && (
          <Button
            variant="outline"
            size="icon"
            onClick={onStop}
            loading={stopPending}
            aria-label="Stop the agent"
          >
            <Square className="size-3.5" />
          </Button>
        )}
        <Button
          size="icon"
          onClick={submit}
          disabled={!sendable}
          loading={sendPending}
          aria-label="Send message"
        >
          <ArrowUp className="size-4" />
        </Button>
      </div>
      {(sendError || message.length > TURN_MESSAGE_MAX_LENGTH * 0.9) && (
        <div className="mx-auto mt-1.5 w-full max-w-3xl">
          {sendError ? (
            // role="alert": the refusal is the ONLY surface saying the
            // message was not accepted — it must reach screen readers too.
            <p role="alert" className="text-destructive text-xs">
              {sendError.message}
            </p>
          ) : (
            <p className="text-muted-foreground text-xs tabular-nums">
              {message.length.toLocaleString()} /{" "}
              {TURN_MESSAGE_MAX_LENGTH.toLocaleString()}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
