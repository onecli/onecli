import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isSlackUploadUrl,
  SLACK_MAX_UPLOAD_BYTES,
  SlackApiError,
  uploadFiles,
} from "./api";
import { startFakeSlackServer, type FakeSlackServer } from "./testing";

/**
 * `uploadFiles` — Slack's three-step external upload, driven against the
 * shared fake server: a ticket per file, raw bytes to the minted URL (no
 * bearer), ONE completion naming every file so N files are one message.
 */

let slack: FakeSlackServer;

beforeEach(async () => {
  slack = await startFakeSlackServer();
  process.env.SLACK_API_BASE_URL = slack.url;
});

afterEach(async () => {
  delete process.env.SLACK_API_BASE_URL;
  await slack.close();
});

describe("uploadFiles: the three steps", () => {
  it("mints a ticket per file, POSTs the exact bytes with NO bearer, completes once with every id, and returns Slack's ids", async () => {
    const a = Buffer.from("clip-bytes");
    const b = Buffer.from("pdf-bytes");
    const result = await uploadFiles("xoxb-1", {
      channel: "C1",
      threadTs: "1700.0001",
      initialComment: "Here you go",
      files: [
        { name: "clip.webm", bytes: a },
        { name: "report.pdf", bytes: b, title: "Q3 report" },
      ],
    });
    expect(result).toEqual({ fileIds: ["F0001", "F0002"] });

    const tickets = slack.callsTo("files.getUploadURLExternal");
    expect(tickets.map((c) => c.form)).toEqual([
      { filename: "clip.webm", length: String(a.byteLength) },
      { filename: "report.pdf", length: String(b.byteLength) },
    ]);
    expect(tickets.every((c) => c.token === "xoxb-1")).toBe(true);

    const puts = slack.calls.filter((c) => c.method.startsWith("upload/v1/"));
    expect(puts).toHaveLength(2);
    expect(Buffer.compare(puts[0]!.bytes, a)).toBe(0);
    expect(Buffer.compare(puts[1]!.bytes, b)).toBe(0);
    // The minted URL is its own credential — the bot token never rides it.
    expect(puts.every((c) => c.token === null)).toBe(true);

    const completes = slack.callsTo("files.completeUploadExternal");
    expect(completes).toHaveLength(1);
    expect(completes[0]!.form).toEqual({
      files: JSON.stringify([
        { id: "F0001" },
        { id: "F0002", title: "Q3 report" },
      ]),
      channel_id: "C1",
      thread_ts: "1700.0001",
      initial_comment: "Here you go",
    });
    expect(completes[0]!.token).toBe("xoxb-1");
  });

  it("omits thread_ts and initial_comment when not given (a top-level share with no text)", async () => {
    await uploadFiles("xoxb-1", {
      channel: "C1",
      files: [{ name: "a.txt", bytes: Buffer.from("a") }],
    });
    const form = slack.callsTo("files.completeUploadExternal")[0]!.form;
    expect(form).toEqual({
      files: JSON.stringify([{ id: "F0001" }]),
      channel_id: "C1",
    });
  });

  it("no files → no calls at all", async () => {
    expect(await uploadFiles("xoxb-1", { channel: "C1", files: [] })).toEqual({
      fileIds: [],
    });
    expect(slack.calls).toHaveLength(0);
  });
});

describe("uploadFiles: refusals and failures", () => {
  it("surfaces a ticket refusal verbatim as SlackApiError and stops before any bytes move", async () => {
    slack.respond("files.getUploadURLExternal", () => ({
      ok: false,
      error: "missing_scope",
    }));
    await expect(
      uploadFiles("xoxb-1", {
        channel: "C1",
        files: [{ name: "a.txt", bytes: Buffer.from("a") }],
      }),
    ).rejects.toMatchObject({ name: "SlackApiError", code: "missing_scope" });
    expect(
      slack.calls.filter((c) => c.method.startsWith("upload/v1/")),
    ).toHaveLength(0);
    expect(slack.callsTo("files.completeUploadExternal")).toHaveLength(0);
  });

  it("surfaces a completion refusal (file_type_not_allowed) verbatim", async () => {
    slack.respond("files.completeUploadExternal", () => ({
      ok: false,
      error: "file_type_not_allowed",
    }));
    await expect(
      uploadFiles("xoxb-1", {
        channel: "C1",
        files: [{ name: "a.exe", bytes: Buffer.from("MZ") }],
      }),
    ).rejects.toMatchObject({ code: "file_type_not_allowed" });
  });

  it("a non-200 from the upload URL fails the share before completion (no half-shared message)", async () => {
    slack.respond("upload/v1/1", () => ({ status: 500 }));
    await expect(
      uploadFiles("xoxb-1", {
        channel: "C1",
        files: [
          { name: "a.txt", bytes: Buffer.from("a") },
          { name: "b.txt", bytes: Buffer.from("b") },
        ],
      }),
    ).rejects.toThrow(/HTTP 500/);
    expect(slack.callsTo("files.completeUploadExternal")).toHaveLength(0);
  });

  it("never follows a redirect off the upload URL — a 3xx fails the share without a second POST", async () => {
    let elsewhereHits = 0;
    const { createServer } = await import("node:http");
    const elsewhere = createServer((req, res) => {
      elsewhereHits += 1;
      req.on("data", () => {});
      req.on("end", () => res.end("got it"));
    });
    await new Promise<void>((r) => elsewhere.listen(0, "127.0.0.1", () => r()));
    const { port } = elsewhere.address() as { port: number };
    try {
      slack.respond("upload/v1/1", () => ({
        status: 307,
        location: `http://127.0.0.1:${port}/steal`,
      }));
      await expect(
        uploadFiles("xoxb-1", {
          channel: "C1",
          files: [{ name: "a.txt", bytes: Buffer.from("secret") }],
        }),
      ).rejects.toThrow(/HTTP 307/);
      expect(elsewhereHits).toBe(0);
      expect(slack.callsTo("files.completeUploadExternal")).toHaveLength(0);
    } finally {
      elsewhere.closeAllConnections();
      await new Promise<void>((r) => elsewhere.close(() => r()));
    }
  });

  it("refuses a minted upload URL outside Slack's hosts before sending a byte", async () => {
    slack.respond("files.getUploadURLExternal", () => ({
      ok: true,
      upload_url: "https://evil.example/upload",
      file_id: "F1",
    }));
    await expect(
      uploadFiles("xoxb-1", {
        channel: "C1",
        files: [{ name: "a.txt", bytes: Buffer.from("a") }],
      }),
    ).rejects.toThrow(/outside its own hosts/);
    expect(
      slack.calls.filter((c) => c.method.startsWith("upload/v1/")),
    ).toHaveLength(0);
  });

  it("an empty file is refused locally as invalid_arguments (Slack's own answer for length 0)", async () => {
    await expect(
      uploadFiles("xoxb-1", {
        channel: "C1",
        files: [{ name: "a.txt", bytes: Buffer.alloc(0) }],
      }),
    ).rejects.toBeInstanceOf(SlackApiError);
    expect(slack.calls).toHaveLength(0);
  });
});

describe("isSlackUploadUrl", () => {
  it("admits files.slack.com over https, and the configured fake origin under test", () => {
    delete process.env.SLACK_API_BASE_URL;
    expect(isSlackUploadUrl("https://files.slack.com/upload/v1/abc")).toBe(
      true,
    );
    expect(isSlackUploadUrl("https://edge.files.slack.com/upload/v1/abc")).toBe(
      true,
    );
    expect(isSlackUploadUrl("http://files.slack.com/upload/v1/abc")).toBe(
      false,
    );
    expect(isSlackUploadUrl("https://slack.com/upload")).toBe(false);
    expect(isSlackUploadUrl("https://files.slack.com.evil.example/x")).toBe(
      false,
    );
    expect(isSlackUploadUrl("not a url")).toBe(false);
    process.env.SLACK_API_BASE_URL = slack.url;
    expect(isSlackUploadUrl(`${slack.url}/upload/v1/1`)).toBe(true);
  });

  it("pins Slack's documented ceiling", () => {
    expect(SLACK_MAX_UPLOAD_BYTES).toBe(1024 ** 3);
  });
});
