import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ATTACHMENT_CHUNK_RAW_BYTES,
  ATTACHMENT_RETENTION_DAYS,
  MAX_OUTBOUND_ATTACHMENT_BYTES,
  MAX_OUTBOUND_ATTACHMENTS_PER_TURN,
  type SupervisorMessage,
  type WorkItem,
} from "@onecli/agent-protocol";
import {
  createSendFileTools,
  mimeTypeFor,
  sendFileFragment,
  type SendFileTools,
} from "./send-file";

/**
 * The send_file tool's LOCAL half: what may leave the sandbox (containment,
 * regular files, the caps), how it leaves (self-describing file.part frames
 * that concatenate byte-exactly), and how the answer comes back (correlated
 * file.result; a timeout is a model-readable error, never a hang).
 */

type FilePart = Extract<SupervisorMessage, { kind: "file.part" }>;
type FileResultBody = Omit<
  Extract<WorkItem, { kind: "file.result" }>,
  "kind" | "uploadId"
>;
const CONTEXT = { conversationId: "cv-1", turnId: "t-1" };

let home: string;
let outside: string;
let sent: SupervisorMessage[];
let tools: SendFileTools;
const tool = () => tools.tools[0]!;
const parts = () => sent.filter((m) => m.kind === "file.part") as FilePart[];
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Run a call and, once its frames are out, answer the correlated result
 * (the runner's job in production). */
const callAnswering = async (
  args: unknown,
  answer: FileResultBody,
  context: { conversationId: string; turnId: string } | null = CONTEXT,
) => {
  const call = tool().execute!(args, context);
  await Promise.resolve(); // frames are emitted before execute first awaits
  const first = parts().at(-1);
  if (first) {
    tools.handleResult({
      kind: "file.result",
      uploadId: first.uploadId,
      ...answer,
    });
  }
  return call;
};

const write = (rel: string, bytes: Buffer): string => {
  const abs = join(home, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, bytes);
  return abs;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sendfile-home-"));
  outside = mkdtempSync(join(tmpdir(), "sendfile-outside-"));
  sent = [];
  tools = createSendFileTools({
    homeDir: home,
    send: (m) => sent.push(m),
    timeoutMs: 200,
  });
});

afterEach(() => {
  tools.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("send_file: the happy path", () => {
  it("streams a regular file as self-describing parts that concatenate byte-exactly, and returns the stored id", async () => {
    const bytes = Buffer.alloc(ATTACHMENT_CHUNK_RAW_BYTES * 2 + 123, 9);
    write("out/clip.webm", bytes);
    const result = await callAnswering(
      { path: "out/clip.webm", caption: "the run" },
      { ok: true, attachmentId: "att-1" },
    );
    expect(result).toEqual({
      ok: true,
      result: {
        sent: true,
        name: "clip.webm",
        sizeBytes: bytes.byteLength,
        mimeType: "video/webm",
        attachmentId: "att-1",
      },
    });
    const ps = parts();
    expect(ps).toHaveLength(3);
    expect(ps.map((p) => p.part)).toEqual([1, 2, 3]);
    expect(new Set(ps.map((p) => p.uploadId)).size).toBe(1);
    for (const p of ps) {
      expect(p).toMatchObject({
        conversationId: "cv-1",
        turnId: "t-1",
        name: "clip.webm",
        mimeType: "video/webm",
        sizeBytes: bytes.byteLength,
        sha256: sha(bytes),
        caption: "the run",
        of: 3,
      });
    }
    const rebuilt = Buffer.concat(
      ps.map((p) => Buffer.from(p.dataBase64, "base64")),
    );
    expect(Buffer.compare(rebuilt, bytes)).toBe(0);
  });

  it("accepts an absolute path under the home and omits the caption when none is given", async () => {
    const abs = write("report.pdf", Buffer.from("%PDF"));
    const result = await callAnswering(
      { path: abs },
      { ok: true, attachmentId: "a" },
    );
    expect(result.ok).toBe(true);
    expect("caption" in parts()[0]!).toBe(false);
    expect(parts()[0]!.mimeType).toBe("application/pdf");
  });

  it("surfaces the platform's refusal verbatim as the tool error", async () => {
    write("x.txt", Buffer.from("x"));
    const result = await callAnswering(
      { path: "x.txt" },
      { ok: false, error: "You can send at most 10 files per reply." },
    );
    expect(result).toEqual({
      ok: false,
      error: "You can send at most 10 files per reply.",
    });
  });
});

describe("send_file: containment (what may NOT leave)", () => {
  it("refuses a path that escapes the home by traversal", async () => {
    writeFileSync(join(outside, "secret"), "s");
    const rel = join(
      "..",
      outside.slice(outside.lastIndexOf("/") + 1),
      "secret",
    );
    const result = await tool().execute!({ path: rel }, CONTEXT);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/home directory/);
    expect(parts()).toHaveLength(0);
  });

  it("refuses an absolute path outside the home", async () => {
    writeFileSync(join(outside, "secret"), "s");
    const result = await tool().execute!(
      { path: join(outside, "secret") },
      CONTEXT,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/home directory/);
    expect(parts()).toHaveLength(0);
  });

  it("follows a symlink at the leaf that stays INSIDE the home, sending the real bytes under the agent's name", async () => {
    write("runs/3/clip.webm", Buffer.from("real"));
    symlinkSync(join(home, "runs/3/clip.webm"), join(home, "latest.webm"));
    const result = await callAnswering(
      { path: "latest.webm" },
      { ok: true, attachmentId: "a" },
    );
    expect(result.ok).toBe(true);
    expect(parts()[0]!.name).toBe("latest.webm");
    expect(Buffer.from(parts()[0]!.dataBase64, "base64").toString()).toBe(
      "real",
    );
  });

  it("refuses a symlink pointing OUTSIDE the home (the exfiltration shape)", async () => {
    writeFileSync(join(outside, "etc-passwd"), "root:x:0:0");
    symlinkSync(join(outside, "etc-passwd"), join(home, "innocent.txt"));
    const result = await tool().execute!({ path: "innocent.txt" }, CONTEXT);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/home directory/);
    expect(parts()).toHaveLength(0);
  });

  it("refuses a symlinked PARENT directory that escapes the home (lexically inside, really outside)", async () => {
    writeFileSync(join(outside, "secret"), "s");
    symlinkSync(outside, join(home, "docs"));
    const result = await tool().execute!({ path: "docs/secret" }, CONTEXT);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/home directory/);
    expect(parts()).toHaveLength(0);
  });

  it("a FIFO is refused, not waited on", async () => {
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [join(home, "pipe")]);
    const result = await tool().execute!({ path: "pipe" }, CONTEXT);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/regular files/);
    expect(parts()).toHaveLength(0);
  });

  it("refuses a directory, a missing file, and an empty file", async () => {
    mkdirSync(join(home, "dir"));
    write("empty.bin", Buffer.alloc(0));
    for (const [path, re] of [
      ["dir", /regular files/],
      ["nope.txt", /No file/],
      ["empty.bin", /empty/],
    ] as const) {
      const result = await tool().execute!({ path }, CONTEXT);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(re);
    }
    expect(parts()).toHaveLength(0);
  });

  it("refuses the home directory itself", async () => {
    const result = await tool().execute!({ path: "." }, CONTEXT);
    expect(result.ok).toBe(false);
    expect(parts()).toHaveLength(0);
  });
});

describe("send_file: caps", () => {
  it("refuses a file over the byte cap before reading it, naming both sizes", async () => {
    write("huge.bin", Buffer.alloc(MAX_OUTBOUND_ATTACHMENT_BYTES + 1));
    const result = await tool().execute!({ path: "huge.bin" }, CONTEXT);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/capped at 25MB/);
    expect(parts()).toHaveLength(0);
  });

  it("enforces the per-turn count locally, per turn", async () => {
    write("f.txt", Buffer.from("f"));
    for (let i = 0; i < MAX_OUTBOUND_ATTACHMENTS_PER_TURN; i += 1) {
      const r = await callAnswering(
        { path: "f.txt" },
        { ok: true, attachmentId: `a${i}` },
      );
      expect(r.ok).toBe(true);
    }
    const over = await tool().execute!({ path: "f.txt" }, CONTEXT);
    expect(over.ok).toBe(false);
    expect(over.error).toMatch(/per reply/);
    // A different turn starts fresh.
    const next = await callAnswering(
      { path: "f.txt" },
      { ok: true, attachmentId: "b" },
      { conversationId: "cv-1", turnId: "t-2" },
    );
    expect(next.ok).toBe(true);
  });

  it("remembers at most 64 turns' counts — a long-lived supervisor does not grow a map forever", async () => {
    write("f.txt", Buffer.from("f"));
    for (let i = 0; i < 70; i += 1) {
      const r = await callAnswering(
        { path: "f.txt" },
        { ok: true, attachmentId: `a${i}` },
        { conversationId: "cv-1", turnId: `t-${i}` },
      );
      expect(r.ok).toBe(true);
    }
    // The oldest turn's count was forgotten: a fresh send on it is allowed
    // locally (the control plane's DB count is the authority anyway).
    for (let i = 0; i < MAX_OUTBOUND_ATTACHMENTS_PER_TURN; i += 1) {
      const r = await callAnswering(
        { path: "f.txt" },
        { ok: true, attachmentId: `b${i}` },
        { conversationId: "cv-1", turnId: "t-0" },
      );
      expect(r.ok).toBe(true);
    }
  });

  it("refuses a caption over the cap and a missing path at the schema", async () => {
    write("f.txt", Buffer.from("f"));
    expect(
      (
        await tool().execute!(
          { path: "f.txt", caption: "c".repeat(501) },
          CONTEXT,
        )
      ).ok,
    ).toBe(false);
    expect((await tool().execute!({}, CONTEXT)).ok).toBe(false);
    expect(parts()).toHaveLength(0);
  });
});

describe("send_file: the answer", () => {
  it("needs an unambiguous live turn: no context → refusal, nothing sent", async () => {
    write("f.txt", Buffer.from("f"));
    const result = await tool().execute!({ path: "f.txt" }, null);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/answering a message/);
    expect(parts()).toHaveLength(0);
  });

  it("times out into a model-readable error that warns the file may have arrived", async () => {
    write("f.txt", Buffer.from("f"));
    const result = await tool().execute!({ path: "f.txt" }, CONTEXT);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/did not confirm/);
    expect(result.error).toMatch(/may have arrived/);
  });

  it("ignores a late or unknown result", () => {
    expect(() =>
      tools.handleResult({ kind: "file.result", uploadId: "nope", ok: true }),
    ).not.toThrow();
  });

  it("close() settles every in-flight call as a timeout", async () => {
    write("f.txt", Buffer.from("f"));
    const call = tool().execute!({ path: "f.txt" }, CONTEXT);
    await Promise.resolve();
    tools.close();
    const result = await call;
    expect(result.ok).toBe(false);
  });
});

describe("send_file: names and types", () => {
  it("maps common extensions and falls back to octet-stream", () => {
    expect(mimeTypeFor("a.PNG")).toBe("image/png");
    expect(mimeTypeFor("clip.webm")).toBe("video/webm");
    expect(mimeTypeFor("data.csv")).toBe("text/csv");
    expect(mimeTypeFor("weird.xyz")).toBe("application/octet-stream");
    expect(mimeTypeFor("noext")).toBe("application/octet-stream");
  });

  it("sends the sanitized basename, never the path", async () => {
    write("deep/dir/My Report (final).pdf", Buffer.from("%PDF"));
    await callAnswering(
      { path: "deep/dir/My Report (final).pdf" },
      { ok: true, attachmentId: "a" },
    );
    expect(parts()[0]!.name).toBe("My Report (final).pdf");
  });
});

describe("send_file: the fragment", () => {
  it("names the tool, the caps, and the two surfaces, and tells the model to read the result", () => {
    const flat = sendFileFragment.body.replace(/\s+/g, " ");
    expect(flat).toContain("send_file");
    expect(flat).toContain(
      `${MAX_OUTBOUND_ATTACHMENTS_PER_TURN} files per reply`,
    );
    expect(flat).toContain("25MB each");
    expect(flat).toContain(`${ATTACHMENT_RETENTION_DAYS} days`);
    expect(flat).toContain("web");
    expect(flat).toContain("Slack");
    expect(flat).toMatch(/read it before telling/);
    expect(sendFileFragment.body).not.toMatch(/jcode/i);
  });
});
