import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  ATTACHMENT_CHUNK_RAW_BYTES,
  ATTACHMENT_RETENTION_DAYS,
  MAX_ATTACHMENT_NAME_CHARS,
  MAX_OUTBOUND_ATTACHMENT_BYTES,
  MAX_OUTBOUND_ATTACHMENTS_PER_TURN,
  MAX_OUTBOUND_CAPTION_CHARS,
  sanitizeAttachmentName,
  type SupervisorMessage,
  type WorkItem,
} from "@onecli/agent-protocol";
import type { CapabilityFragment } from "../home/renderer";
import type { PlatformToolDefinition } from "../platform-tools";
import { log } from "../log";

/**
 * The send-file capability (Tier 3 of plans/agent-owns-its-machine.md): the
 * agent hands a file back to the person, attached to the reply it is writing
 * — chips under the answer on the web, an in-thread upload on Slack.
 *
 * LOCAL execution (the process tools' law): the bytes live in this container
 * and only this process can read them, so the tool itself does the reading
 * and streams the file to the runner as `file.part` frames over the existing
 * transport (the inbound `attachment.part` reversed). The runner reassembles,
 * verifies, and relays to the control plane, which fences and stores; the
 * correlated `file.result` is what the model reads. Nothing here decides
 * WHO may receive the file — that is the control plane's fence (turn under
 * the agent's conversation, still live); this module decides only WHAT may
 * leave: a regular file under the home, within the caps.
 *
 * Containment, in order: the path's REAL location (symlinks resolved, at
 * every level) lies under the home's real location — a symlink INTO the home
 * is fine (`~/latest -> ~/runs/3/clip.webm` sends the clip), one out of it is
 * refused whether at the leaf or in a parent; it is then opened O_NOFOLLOW
 * (a symlink planted between resolve and open is refused, not followed) and
 * fstat'd on the descriptor (never lstat-then-open — the classic race); it is
 * a REGULAR file; and its size fits the belt BEFORE a byte is read. The
 * sha256 is computed over the bytes actually read and travels on every part,
 * so a file the agent rewrites mid-send fails the runner's verify instead of
 * landing half-old.
 *
 * What this is and is not: the agent can read anything its uid can read and
 * copy it into the home first, so containment is a DISCIPLINE (files leave
 * from the agent's own space, by a path it can name) rather than a boundary
 * against the agent. The boundary against everyone else is the control
 * plane's fence.
 */

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  webm: "video/webm",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pdf: "application/pdf",
  json: "application/json",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  xml: "application/xml",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  js: "text/javascript",
  ts: "text/plain",
  py: "text/x-python",
  sh: "text/x-shellscript",
  yaml: "application/yaml",
  yml: "application/yaml",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** Media type from the extension; unknown → octet-stream (the api's
 * normalizer would land there anyway, and a wrong sniff is worse than a
 * generic type: Slack and the browser both key previews off it). */
export const mimeTypeFor = (name: string): string => {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return (
    MIME_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? "application/octet-stream"
  );
};

/** Under jcode's own 30 s MCP-call failure, and above the runner's 60 s api
 * timeout is NOT possible — so a slow api surfaces as this error rather than
 * the vendor's generic one. The runner answers every run it sees; this only
 * fires when the frames never reached it or its answer never came back. */
export const SEND_FILE_TIMEOUT_MS = 28_000;

const argsSchema = z.object({
  path: z.string().min(1).max(4096),
  caption: z.string().max(MAX_OUTBOUND_CAPTION_CHARS).optional(),
});

export interface SendFileOptions {
  /** The durable home; files may only be sent from under it. */
  homeDir: string;
  send: (message: SupervisorMessage) => void;
  /** Test seam only. */
  timeoutMs?: number;
}

type FileResult = Extract<WorkItem, { kind: "file.result" }>;

export interface SendFileTools {
  tools: PlatformToolDefinition[];
  /** Resolve a correlated result — called INLINE from the reader loop. */
  handleResult(item: FileResult): void;
  /** Reject everything in flight (shutdown). */
  close(): void;
}

const refuse = (error: string): { ok: false; error: string } => ({
  ok: false,
  error,
});

/** Turns whose local send count is remembered. One live turn per
 * conversation, a handful of conversations per sandbox: 64 is generous, and
 * the bound is what matters — a supervisor lives across thousands of turns. */
const MAX_REMEMBERED_TURNS = 64;

export const createSendFileTools = (
  options: SendFileOptions,
): SendFileTools => {
  const home = resolve(options.homeDir);
  const pending = new Map<
    string,
    { resolve: (result: FileResult | null) => void; timer: NodeJS.Timeout }
  >();
  // Per-turn count, enforced locally for a fast, honest refusal; the control
  // plane enforces the same cap against the database (its count is the one
  // that holds across a supervisor restart mid-turn). Bounded, oldest-first:
  // a Map iterates in insertion order.
  const sentPerTurn = new Map<string, number>();
  const rememberSent = (turnId: string, count: number): void => {
    sentPerTurn.set(turnId, count);
    while (sentPerTurn.size > MAX_REMEMBERED_TURNS) {
      const oldest = sentPerTurn.keys().next().value;
      if (oldest === undefined) break;
      sentPerTurn.delete(oldest);
    }
  };

  /**
   * The agent's path, resolved to its REAL location and checked against the
   * home's real location. Lexical containment first (cheap, and `..` never
   * gets to touch the filesystem), then realpath so a symlink anywhere in
   * the chain cannot point the read outside the home. Errors are the
   * caller's to word: a missing file is the common case, not an attack.
   */
  const containedPath = (
    raw: string,
  ): { ok: true; path: string } | { ok: false; error: string } => {
    const outside = refuse(
      "Files can only be sent from your home directory (/workspace).",
    );
    const candidate = isAbsolute(raw) ? resolve(raw) : resolve(home, raw);
    const lexical = relative(home, candidate);
    if (lexical === "" || lexical.startsWith("..") || isAbsolute(lexical)) {
      return outside;
    }
    let real: string;
    let realHome: string;
    try {
      realHome = realpathSync(home);
      real = realpathSync(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR")
        return refuse("No file at that path.");
      if (code === "ELOOP")
        return refuse("That path is a symlink loop; send the real file.");
      return refuse(`That path could not be resolved (${code ?? "error"}).`);
    }
    const rel = relative(realHome, real);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return outside;
    if (rel.split(sep).some((seg) => seg === "..")) return outside;
    return { ok: true, path: real };
  };

  /**
   * Read the file with the open-then-fstat discipline: the descriptor is
   * what gets checked and read, so a swap between check and read cannot
   * substitute a different file. The path is already the real one, so
   * O_NOFOLLOW only ever bites a symlink planted AFTER resolution — refused,
   * never followed. O_NONBLOCK keeps a FIFO from parking the tool forever on
   * open; fstat then refuses it as not a regular file.
   */
  const readContained = (
    path: string,
  ): { ok: true; bytes: Buffer } | { ok: false; error: string } => {
    let fd: number;
    try {
      // Portable through fs.constants (O_NOFOLLOW is Linux 0o400000, macOS
      // 0x100 — the tests run on both).
      fd = openSync(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP")
        return refuse("That path is a symlink; send the real file.");
      if (code === "ENOENT") return refuse("No file at that path.");
      if (code === "EACCES") return refuse("That file cannot be read.");
      return refuse(`That file could not be opened (${code ?? "error"}).`);
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) return refuse("Only regular files can be sent.");
      if (stat.size === 0) return refuse("That file is empty.");
      if (stat.size > MAX_OUTBOUND_ATTACHMENT_BYTES) {
        return refuse(
          `That file is ${(stat.size / (1024 * 1024)).toFixed(1)}MB; files are capped at ${Math.floor(MAX_OUTBOUND_ATTACHMENT_BYTES / (1024 * 1024))}MB.`,
        );
      }
      // Read EXACTLY the fstat size: a file growing under us cannot push the
      // buffer past the belt, and the sha travels over what was read.
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < stat.size) {
        const n = readSync(fd, bytes, offset, stat.size - offset, offset);
        if (n <= 0) break;
        offset += n;
      }
      if (offset !== stat.size)
        return refuse("That file changed while being read; try again.");
      return { ok: true, bytes };
    } finally {
      closeSync(fd);
    }
  };

  const awaitResult = (uploadId: string): Promise<FileResult | null> =>
    new Promise((resolveResult) => {
      const timer = setTimeout(() => {
        pending.delete(uploadId);
        resolveResult(null);
      }, options.timeoutMs ?? SEND_FILE_TIMEOUT_MS);
      timer.unref();
      pending.set(uploadId, { resolve: resolveResult, timer });
    });

  const sendFile = async (
    args: unknown,
    context: { conversationId: string; turnId: string } | null,
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> => {
    const parsed = argsSchema.safeParse(args);
    if (!parsed.success)
      return refuse(parsed.error.issues[0]?.message ?? "Invalid input");
    if (!context) {
      // Files attach to a reply; with no unambiguous live turn there is
      // nothing to attach to (two turns in flight, or a call outside one).
      return refuse("send_file works only while you are answering a message.");
    }
    const count = sentPerTurn.get(context.turnId) ?? 0;
    if (count >= MAX_OUTBOUND_ATTACHMENTS_PER_TURN) {
      return refuse(
        `You can send at most ${MAX_OUTBOUND_ATTACHMENTS_PER_TURN} files per reply.`,
      );
    }

    const contained = containedPath(parsed.data.path);
    if (!contained.ok) return contained;
    const read = readContained(contained.path);
    if (!read.ok) return read;

    // The name the AGENT gave (a symlink's own name, not its target's): that
    // is what it will call the file when it tells the person.
    const name = sanitizeAttachmentName(
      basename(parsed.data.path).slice(0, MAX_ATTACHMENT_NAME_CHARS * 2),
    );
    const mimeType = mimeTypeFor(name);
    const sha256 = createHash("sha256").update(read.bytes).digest("hex");
    const uploadId = randomUUID();
    const of = Math.max(
      1,
      Math.ceil(read.bytes.byteLength / ATTACHMENT_CHUNK_RAW_BYTES),
    );

    // Count BEFORE sending: a refusal below still cost the slot for this
    // turn, which is the conservative reading (the control plane's count is
    // the authority; this one only makes the fast path honest).
    rememberSent(context.turnId, count + 1);
    const waiter = awaitResult(uploadId);
    try {
      for (let part = 1; part <= of; part += 1) {
        const start = (part - 1) * ATTACHMENT_CHUNK_RAW_BYTES;
        options.send({
          kind: "file.part",
          uploadId,
          conversationId: context.conversationId,
          turnId: context.turnId,
          name,
          mimeType,
          sizeBytes: read.bytes.byteLength,
          sha256,
          ...(parsed.data.caption !== undefined && {
            caption: parsed.data.caption,
          }),
          part,
          of,
          dataBase64: read.bytes
            .subarray(start, start + ATTACHMENT_CHUNK_RAW_BYTES)
            .toString("base64"),
        });
      }
    } catch (error) {
      // A dying transport: the waiter would time out; settle it now instead.
      const entry = pending.get(uploadId);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(uploadId);
      }
      log("warn", "send_file: transport write failed", {
        error: String(error),
      });
      return refuse("The file could not be sent (connection lost). Try again.");
    }

    const result = await waiter;
    if (!result) {
      return refuse(
        "The platform did not confirm the file in time. It may have arrived — check before sending it again.",
      );
    }
    if (!result.ok) {
      return refuse(result.error ?? "The file was not accepted.");
    }
    return {
      ok: true,
      result: {
        sent: true,
        name,
        sizeBytes: read.bytes.byteLength,
        mimeType,
        attachmentId: result.attachmentId,
      },
    };
  };

  return {
    tools: [
      {
        name: "send_file",
        description: `Attach a file from your home directory to your current reply so the person receives it (shown under your answer on the web; uploaded into the thread on Slack). Use it for anything you produced that they should have — a screenshot, a recording, a report, a CSV, a zip — instead of pasting its contents. Up to ${MAX_OUTBOUND_ATTACHMENTS_PER_TURN} files per reply, ${Math.floor(MAX_OUTBOUND_ATTACHMENT_BYTES / (1024 * 1024))}MB each. The result says sent (the file is with them) or why not.`,
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "Path to the file, absolute (under /workspace) or relative to your home directory.",
            },
            caption: {
              type: "string",
              description:
                "Optional one-line note shown with the file (what it is, what to look at).",
              maxLength: MAX_OUTBOUND_CAPTION_CHARS,
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
        execute: sendFile,
      },
    ],
    handleResult(item) {
      const waiter = pending.get(item.uploadId);
      if (!waiter) return; // timed out already — nothing waits
      pending.delete(item.uploadId);
      clearTimeout(waiter.timer);
      waiter.resolve(item);
    },
    close() {
      for (const [uploadId, waiter] of pending) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
        pending.delete(uploadId);
      }
    },
  };
};

export const sendFileFragment: CapabilityFragment = {
  id: "send-file",
  title: "Sending files back",
  body: `When you produce something the person should HAVE — a screenshot, a
recording, a report, a data export, an archive — send the file, do not paste
its contents or hand them a path they cannot open. Call send_file with the
file's path (under /workspace) and an optional caption; it attaches to the
reply you are writing: under your answer on the web, uploaded into the
thread on Slack. Up to ${MAX_OUTBOUND_ATTACHMENTS_PER_TURN} files per reply,
${Math.floor(MAX_OUTBOUND_ATTACHMENT_BYTES / (1024 * 1024))}MB each; a sent
file stays downloadable for ${ATTACHMENT_RETENTION_DAYS} days, so say so if
the person may need it later. The result says sent, or exactly why not —
read it before telling the person the file is on its way.`,
};
