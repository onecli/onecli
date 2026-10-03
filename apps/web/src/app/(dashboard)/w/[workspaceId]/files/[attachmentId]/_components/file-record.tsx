"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import {
  Download,
  FileArchive,
  FileAudio,
  FileClock,
  FileImage,
  FileQuestion,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Loader2,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";
import { ATTACHMENT_RETENTION_DAYS } from "@onecli/api/validations/attachments";
import { Button } from "@onecli/ui/components/button";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { cn } from "@onecli/ui/lib/utils";
import type { AttachmentPageMeta } from "@/lib/api/types";
import { ApiError } from "@/lib/api/client";
import { ATTACHMENT_CONVERSATION_PARAM, agentChatPath } from "@/lib/navigation";
import {
  useAttachmentMeta,
  useDownloadAttachment,
} from "@/hooks/use-attachments";

/**
 * The record of one file an agent sent (send_file), for a link that arrives
 * from OUTSIDE the web — the Slack line for a file that could not be uploaded
 * into the thread. The chat renders only direct threads, so for a channel
 * thread this page is the only place the file exists on the web.
 *
 * It reads like a document's title page: the file's name and glyph, then the
 * facts (type, size, who sent it, when, from where, how long it stays), the
 * agent's caption as a quoted note, and one primary action. Download goes
 * through the chat's own hook — a presigned bucket URL when the backend
 * mints one, the authenticated blob otherwise — and never renders the bytes
 * inline (agent-authored bytes must not execute on this origin). The fence is
 * the API's (`requireConversation`): a link pasted to someone outside the
 * workspace lands on login or on "not available", never on bytes. `?c=` names
 * the conversation; without it there is nothing to fence against, so the
 * page says so instead of guessing. An expired row (retention took the
 * bytes) keeps its record and says what happened.
 */

/** The file-type family a media type belongs to — the glyph key. */
type FileFamily =
  | "image"
  | "video"
  | "audio"
  | "sheet"
  | "archive"
  | "document"
  | "other";

const FAMILY_ICON: Record<FileFamily, LucideIcon> = {
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  sheet: FileSpreadsheet,
  archive: FileArchive,
  document: FileText,
  other: FileQuestion,
};

const familyOf = (mimeType: string): FileFamily => {
  const type = mimeType.toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (
    type === "text/csv" ||
    type.includes("spreadsheet") ||
    type === "application/vnd.ms-excel"
  ) {
    return "sheet";
  }
  if (
    type === "application/zip" ||
    type === "application/gzip" ||
    type === "application/x-tar"
  ) {
    return "archive";
  }
  if (
    type.startsWith("text/") ||
    type === "application/pdf" ||
    type === "application/json"
  ) {
    return "document";
  }
  return "other";
};

/** The glyph tile — the same bordered square the Connections detail page
 * gives an app's icon, so a file and an app read as peers. Expired files get
 * the clock, dimmed. */
const FileGlyph = ({
  mimeType,
  expired,
}: {
  mimeType: string;
  expired: boolean;
}) => {
  const Icon = expired ? FileClock : FAMILY_ICON[familyOf(mimeType)];
  return (
    <div
      className={cn(
        "bg-muted flex size-12 shrink-0 items-center justify-center rounded-xl border dark:border-white/10 dark:bg-white/10",
        expired && "border-dashed",
      )}
    >
      <Icon
        className={cn(
          "size-6",
          expired ? "text-muted-foreground/60" : "text-muted-foreground",
        )}
        aria-hidden
      />
    </div>
  );
};

/**
 * Human size: the number through Intl (locale digits and separators), the
 * unit as the plain abbreviation everyone reads (Intl's `unit` style says
 * "21 byte", which no one does), joined with a non-breaking space.
 */
const SIZE_UNITS = ["B", "KB", "MB", "GB"] as const;
const formatSize = (bytes: number): string => {
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < SIZE_UNITS.length - 1) {
    value /= 1024;
    index += 1;
  }
  const number = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: index === 0 ? 0 : 1,
  }).format(value);
  return `${number}\u00a0${SIZE_UNITS[index]}`;
};

/** A parsed ISO stamp, or null for anything Date rejects — a bad value
 * degrades one cell, never the page (`Intl.format(Invalid Date)` throws). */
const parseWhen = (iso: string): Date | null => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatWhen = (date: Date): string =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);

const formatDay = (date: Date): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);

/** Where the conversation happened, in the person's words. Unknown sources
 * (a provider added later) fall back to their id, capitalized. */
const SOURCE_LABEL: Record<string, string> = {
  web: "Web chat",
  slack: "Slack",
  cron: "Scheduled run",
  watch: "Process watch",
};
const sourceLabel = (source: string): string =>
  SOURCE_LABEL[source] ??
  source.charAt(0).toUpperCase() + source.slice(1).replace(/-/g, " ");

const retentionEnd = (createdAt: Date): Date =>
  new Date(
    createdAt.getTime() + ATTACHMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );

/** The card's shell — every state renders inside it, so the page always
 * looks like a file record, never like a bare notice. */
const Frame = ({
  children,
  enter = true,
}: {
  children: React.ReactNode;
  /** The one entrance: the settled record (or a notice) slides in once.
   * The skeleton does not — it is what the record replaces, and two
   * entrances in a row read as a flicker. */
  enter?: boolean;
}) => (
  <div
    className={cn(
      "bg-card text-card-foreground w-full max-w-2xl overflow-hidden rounded-xl border",
      enter &&
        "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300",
    )}
  >
    {children}
  </div>
);

const Fact = ({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) => (
  <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-6 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)]">
    <dt className="text-muted-foreground text-sm">{label}</dt>
    <dd
      className={cn(
        "min-w-0 text-sm break-words",
        mono && "font-mono text-[13px] tabular-nums",
      )}
    >
      {children}
    </dd>
  </div>
);

const Record = ({
  meta,
  conversationId,
  workspaceId,
}: {
  meta: AttachmentPageMeta;
  conversationId: string;
  workspaceId: string;
}) => {
  const download = useDownloadAttachment(conversationId);
  const expired = meta.status === "expired";
  const agent = meta.conversation.agent;
  const chatHref = agentChatPath(workspaceId, agent.id);
  const landed = parseWhen(meta.createdAt);
  const keepsUntil = landed && retentionEnd(landed);

  return (
    <Frame>
      <header className="flex items-start gap-4 p-6">
        <FileGlyph mimeType={meta.mimeType} expired={expired} />
        <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
          <h1
            className={cn(
              "text-xl font-semibold tracking-tight break-all text-balance",
              expired && "text-muted-foreground line-through decoration-1",
            )}
            translate="no"
          >
            {meta.name}
          </h1>
          <p className="text-muted-foreground text-sm">
            {meta.direction === "outbound" ? (
              <>
                Sent by{" "}
                <Link
                  href={chatHref}
                  className="text-foreground decoration-muted-foreground/50 hover:decoration-foreground underline underline-offset-4 transition-colors"
                >
                  {agent.name}
                </Link>
              </>
            ) : (
              "Attached to the conversation"
            )}
            {landed && (
              <>
                {" "}
                ·{" "}
                <time dateTime={landed.toISOString()}>
                  {formatWhen(landed)}
                </time>
              </>
            )}
          </p>
        </div>
      </header>

      <dl className="divide-border/60 mx-6 divide-y border-y">
        <Fact label="Type" mono>
          <span translate="no">{meta.mimeType}</span>
        </Fact>
        <Fact label="Size">
          <span className="tabular-nums" translate="no">
            {formatSize(meta.sizeBytes)}
          </span>
        </Fact>
        <Fact label="From">{sourceLabel(meta.conversation.source)}</Fact>
        <Fact label={expired ? "Expired" : "Available until"}>
          {keepsUntil && (
            <time dateTime={keepsUntil.toISOString()} className="tabular-nums">
              {formatDay(keepsUntil)}
            </time>
          )}
          <span className="text-muted-foreground">
            {keepsUntil && " · "}files stay {ATTACHMENT_RETENTION_DAYS}
            &nbsp;days
          </span>
        </Fact>
      </dl>

      {meta.caption && (
        <figure className="px-6 pt-5">
          <blockquote className="border-brand/60 text-pretty border-l-2 pl-4 text-sm leading-relaxed break-words">
            {meta.caption}
          </blockquote>
          <figcaption className="text-muted-foreground mt-2 pl-4 text-xs">
            {agent.name}&rsquo;s note
          </figcaption>
        </figure>
      )}

      <footer className="mt-6 flex flex-wrap items-center gap-3 border-t bg-muted/30 px-6 py-4">
        {expired ? (
          <p
            className="text-muted-foreground flex items-center gap-2 text-sm"
            role="status"
          >
            <FileClock className="size-4 shrink-0" aria-hidden />
            This file expired after {ATTACHMENT_RETENTION_DAYS}&nbsp;days and
            can&rsquo;t be downloaded.
          </p>
        ) : (
          <Button
            onClick={() => download.mutate(meta)}
            disabled={download.isPending}
            aria-busy={download.isPending}
            className="min-w-36"
          >
            {download.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Download className="size-4" aria-hidden />
            )}
            {download.isPending ? "Downloading…" : "Download"}
          </Button>
        )}
        <Button variant="outline" asChild className={cn(expired && "ml-auto")}>
          <Link href={chatHref} aria-label={`Open chat with ${agent.name}`}>
            <MessageSquare className="size-4" aria-hidden />
            Open Chat
          </Link>
        </Button>
      </footer>
    </Frame>
  );
};

/** A state that has no record to show: the same frame, a glyph, a sentence
 * that says what happened and what to do, one action. */
const Notice = ({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
}) => (
  <Frame>
    <div className="flex items-start gap-4 p-6">
      <div className="bg-muted flex size-12 shrink-0 items-center justify-center rounded-xl border border-dashed dark:border-white/10 dark:bg-white/10">
        <Icon className="text-muted-foreground size-6" aria-hidden />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
        <h1 className="text-xl font-semibold tracking-tight text-balance">
          {title}
        </h1>
        <p className="text-muted-foreground text-pretty text-sm">
          {description}
        </p>
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  </Frame>
);

const RecordSkeleton = () => (
  <Frame enter={false}>
    <div aria-busy aria-label="Loading file…">
      <div className="flex items-start gap-4 p-6">
        <Skeleton className="size-12 rounded-xl" />
        <div className="flex flex-1 flex-col gap-2 pt-1">
          <Skeleton className="h-6 w-64 max-w-full" />
          <Skeleton className="h-4 w-48 max-w-full" />
        </div>
      </div>
      <div className="mx-6 flex flex-col gap-4 border-y py-4">
        <Skeleton className="h-4 w-72 max-w-full" />
        <Skeleton className="h-4 w-56 max-w-full" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
      <div className="mt-6 flex gap-3 border-t px-6 py-4">
        <Skeleton className="h-9 w-36" />
        <Skeleton className="h-9 w-32" />
      </div>
    </div>
  </Frame>
);

export const FileRecord = () => {
  const params = useParams<{ workspaceId: string; attachmentId: string }>();
  const searchParams = useSearchParams();
  const conversationId = searchParams.get(ATTACHMENT_CONVERSATION_PARAM) ?? "";
  const meta = useAttachmentMeta(conversationId, params.attachmentId);

  if (!conversationId) {
    return (
      <Notice
        icon={FileQuestion}
        title="This link is incomplete."
        description="It does not say which conversation the file belongs to. Open it again from where you got it."
      />
    );
  }
  if (meta.isPending) return <RecordSkeleton />;
  if (meta.isError) {
    const fenced = meta.error instanceof ApiError && meta.error.status === 404;
    return fenced ? (
      <Notice
        icon={FileQuestion}
        title="This file isn’t available."
        description="It may have been removed, or it belongs to a conversation you don’t have access to. Ask whoever shared the link to send it again."
      />
    ) : (
      <Notice
        icon={FileQuestion}
        title="Couldn’t load this file."
        description="The dashboard couldn’t reach the API. It may be a hiccup."
        action={
          <Button variant="outline" size="sm" onClick={() => meta.refetch()}>
            Try Again
          </Button>
        }
      />
    );
  }
  return (
    <Record
      meta={meta.data}
      conversationId={conversationId}
      workspaceId={params.workspaceId}
    />
  );
};
