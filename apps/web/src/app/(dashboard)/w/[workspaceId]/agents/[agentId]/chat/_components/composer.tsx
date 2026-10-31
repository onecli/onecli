"use client";

import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Ref } from "react";
import { ArrowUp, Paperclip, Square, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { Textarea } from "@onecli/ui/components/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
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
import { FilePreviewDialog } from "./file-preview/file-preview-dialog";
import { previewKind } from "./file-preview/file-kind";
import { StagedCardFace } from "./staged-card-face";

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
export interface StagedAttachment {
  key: number;
  name: string;
  sizeBytes: number;
  status: "uploading" | "ready";
  /** Server row, once the upload lands. */
  meta?: AttachmentMeta;
  /** Composer-owned local preview for image files. */
  objectUrl?: string;
  /** The picked file, for the click-to-preview dialog. Absent on a draft
   * restored after a failed send (no local file to read). */
  file?: File;
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
  /** Lets the chat pane's drop zone stage files dropped anywhere on it. */
  ref?: Ref<ComposerHandle>;
}

export interface ComposerHandle {
  stageFiles: (files: Iterable<File>) => void;
}

/** A local image thumbnail (raster only, the same rule as the preview), or
 * nothing: never a throw (jsdom and old engines lack
 * `URL.createObjectURL`; a missing thumbnail degrades to the type badge). */
const previewUrl = (file: File): string | undefined => {
  if (previewKind(file.name, file.type) !== "image") return undefined;
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
  ref,
}: ComposerProps) => {
  // Initial state, not an effect: the draft is there on the first paint, so
  // the field never flashes empty and a re-render can't resurrect it after
  // the user clears it.
  const [message, setMessage] = useState(initialDraft ?? "");
  const [staged, setStaged] = useState<StagedAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Read by `stageFiles` for the room check — it must not compute capacity
   * inside a state updater (see its header). */
  const stagedRef = useRef<StagedAttachment[]>(staged);
  const mountedRef = useRef(true);
  // Local previews never leave the composer. Message tiles use the
  // authenticated bytes cache for both optimistic and settled attachments.
  const ownedUrls = useRef(new Set<string>());
  const updateStaged = (entries: StagedAttachment[]) => {
    stagedRef.current = entries;
    setStaged(entries);
  };
  useEffect(() => {
    const urls = ownedUrls.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);
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
    if (stagedRef.current.length > 0) return;
    updateStaged(
      failedAttachments.map((attachment) => ({
        key: nextKey++,
        name: attachment.name,
        sizeBytes: attachment.sizeBytes,
        status: "ready",
        meta: attachment,
      })),
    );
  }, [failedAttachments]);

  const removeStaged = (key: number) => {
    const entry = stagedRef.current.find((e) => e.key === key);
    if (entry?.objectUrl && ownedUrls.current.delete(entry.objectUrl)) {
      URL.revokeObjectURL(entry.objectUrl);
    }
    updateStaged(stagedRef.current.filter((e) => e.key !== key));
  };

  const uploadEntry = async (entry: StagedAttachment & { file: File }) => {
    const isActive = () =>
      mountedRef.current && stagedRef.current.some((e) => e.key === entry.key);
    try {
      const meta = await uploadFile(entry.file);
      if (!isActive()) return;
      updateStaged(
        stagedRef.current.map((e) =>
          e.key === entry.key ? { ...e, status: "ready", meta } : e,
        ),
      );
    } catch (error: unknown) {
      if (!isActive()) return;
      const reason = error instanceof Error ? error.message : "Upload failed";
      // Collapse identical batch failures into one toast.
      toast.error(`Couldn't attach "${entry.name}". ${reason}`, { id: reason });
      removeStaged(entry.key);
    }
  };

  // Reserve capacity synchronously, and keep uploads and URL creation out of
  // React updaters, which StrictMode may run more than once.
  const stageFiles = (files: Iterable<File>) => {
    if (!mountedRef.current) return;
    const incoming = [...files];
    if (incoming.length === 0) return;

    const room = MAX_ATTACHMENTS_PER_MESSAGE - stagedRef.current.length;
    if (incoming.length > room) {
      toast.warning(
        `You can add at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments to a message. Please select fewer attachments.`,
      );
    }

    const accepted: (StagedAttachment & { file: File })[] = [];
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
      const entry: StagedAttachment & { file: File } = {
        key: nextKey++,
        name: file.name || "file",
        sizeBytes: file.size,
        status: "uploading",
        objectUrl: previewUrl(file),
        file,
      };
      accepted.push(entry);
      if (entry.objectUrl) ownedUrls.current.add(entry.objectUrl);
    }
    if (accepted.length === 0) return;
    // Reserve capacity before starting uploads or yielding to another input.
    updateStaged([...stagedRef.current, ...accepted]);
    for (const entry of accepted) {
      void uploadEntry(entry);
    }
  };

  useImperativeHandle(ref, () => ({ stageFiles }));

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
    onSend({
      message: trimmed,
      attachments: ready.map((e) => e.meta),
    });
    setMessage("");
    for (const url of ownedUrls.current) URL.revokeObjectURL(url);
    ownedUrls.current.clear();
    updateStaged([]);
  };

  return (
    <div className={cn("shrink-0 border-t p-3", className)}>
      {staged.length > 0 && (
        // One scrolling row of cards (like Claude's composer), never a wall of
        // wrapped chips that pushes the conversation up. pt-2/pr-2 keep each
        // card's corner remove button inside the scroll box, unclipped.
        <div className="mx-auto mb-1 flex w-full max-w-3xl gap-2 overflow-x-auto pt-2 pr-2 pb-1">
          {staged.map((entry) => (
            <div
              key={entry.key}
              className="group bg-background relative flex h-16 w-52 shrink-0 items-center gap-3 rounded-xl border p-2 pr-3"
            >
              {entry.file ? (
                <FilePreviewDialog
                  previewKey={`staged:${entry.key}`}
                  name={entry.name}
                  mimeType={entry.file.type}
                  sizeBytes={entry.sizeBytes}
                  imageUrl={entry.objectUrl}
                  loadBlob={async () => {
                    if (!entry.file)
                      throw new Error("Local file is unavailable");
                    return entry.file;
                  }}
                >
                  <button
                    type="button"
                    aria-label={`Preview ${entry.name}`}
                    className="focus-visible:ring-ring flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg text-left focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <StagedCardFace entry={entry} />
                  </button>
                </FilePreviewDialog>
              ) : (
                // A draft restored after a failed send: no local file to read.
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <StagedCardFace entry={entry} />
                </div>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => removeStaged(entry.key)}
                    aria-label={`Remove ${entry.name}`}
                    // Shown on hover/focus so a row of cards stays calm; always
                    // reachable by keyboard and on touch (no hover there).
                    className="text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute -top-1.5 -right-1.5 flex size-11 items-start justify-end rounded-lg opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none [@media(hover:none)]:opacity-100"
                  >
                    <span className="bg-background pointer-events-none flex size-6 items-center justify-center rounded-full border shadow-sm">
                      <X className="size-3" aria-hidden />
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-64">
                  <span className="block truncate">Remove {entry.name}</span>
                </TooltipContent>
              </Tooltip>
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
      <div className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-md">
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
          dir="auto"
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
