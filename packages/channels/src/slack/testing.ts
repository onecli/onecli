import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The fake Slack Web API server — the provider's one test seam
 * (`SLACK_API_BASE_URL`, read at call time by the client). A real
 * `node:http` server, no mocking framework, no patched modules; extracted
 * from the adapter's fakes when the client moved here, so every consumer
 * of `@onecli/channels/slack` tests against the same fake.
 */

// ── Fake Slack Web API server ───────────────────────────────────────────────

export interface RecordedSlackCall {
  /** The Slack method name, e.g. `chat.postMessage` (the URL path). */
  method: string;
  /** The bearer token the client presented. */
  token: string | null;
  /** The decoded x-www-form-urlencoded body. */
  form: Record<string, string>;
  /** The RAW body — what an upload-URL POST carried (file bytes). */
  bytes: Buffer;
  /** What the fake answered — postMessage responses carry the minted ts. */
  response: Record<string, unknown>;
}

export interface FakeSlackServer {
  url: string;
  calls: RecordedSlackCall[];
  callsTo: (method: string) => RecordedSlackCall[];
  /** Override the response for one method (e.g. script an ok:false). */
  respond: (
    method: string,
    handler: (form: Record<string, string>) => Record<string, unknown>,
  ) => void;
  /** Fired as each request ARRIVES — for cross-fake order recording. */
  onCall?: (call: RecordedSlackCall) => void;
  close: () => Promise<void>;
}

export const startFakeSlackServer = async (): Promise<FakeSlackServer> => {
  const calls: RecordedSlackCall[] = [];
  const overrides = new Map<
    string,
    (form: Record<string, string>) => Record<string, unknown>
  >();
  let tsCounter = 0;
  let fileCounter = 0;

  const defaultResponse = (
    method: string,
    form: Record<string, string>,
  ): Record<string, unknown> => {
    if (method === "apps.connections.open") {
      return { ok: true, url: "wss://fake.slack/link" };
    }
    if (method === "chat.postMessage") {
      tsCounter += 1;
      return {
        ok: true,
        channel: form.channel ?? "C0",
        ts: `1700.${String(tsCounter).padStart(4, "0")}`,
      };
    }
    if (method === "chat.update") return { ok: true, ts: form.ts ?? "0.0" };
    // The external-upload handshake: a ticket per file, minted onto THIS
    // fake's origin (the client's host pin admits the configured base).
    if (method === "files.getUploadURLExternal") {
      fileCounter += 1;
      return {
        ok: true,
        upload_url: `${fake.url}/upload/v1/${fileCounter}`,
        file_id: `F${String(fileCounter).padStart(4, "0")}`,
      };
    }
    if (method === "files.completeUploadExternal") {
      let files: { id: string }[] = [];
      try {
        files = JSON.parse(form.files ?? "[]") as { id: string }[];
      } catch {
        // Malformed — an empty share, which the client's schema still parses.
      }
      return { ok: true, files: files.map((f) => ({ id: f.id })) };
    }
    return { ok: true };
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      const bytes = Buffer.concat(chunks);
      const method = (req.url ?? "/").replace(/^\//, "");
      const auth = req.headers.authorization;
      const token = auth?.startsWith("Bearer ")
        ? auth.slice("Bearer ".length)
        : null;
      // An upload-URL POST is file bytes, not a Web API call: record it and
      // answer Slack's bare 200 (its body is not JSON).
      if (method.startsWith("upload/v1/")) {
        const record: RecordedSlackCall = {
          method,
          token,
          form: {},
          bytes,
          response: {},
        };
        calls.push(record);
        fake.onCall?.(record);
        const override = overrides.get(method);
        if (override) {
          const scripted = override({});
          res.statusCode = Number(scripted.status ?? 200);
          if (typeof scripted.location === "string") {
            res.setHeader("location", scripted.location);
          }
          res.end("");
          return;
        }
        res.end("OK - 1");
        return;
      }
      const form = Object.fromEntries(
        new URLSearchParams(bytes.toString("utf8")),
      );
      const override = overrides.get(method);
      const response = override
        ? override(form)
        : defaultResponse(method, form);
      const record: RecordedSlackCall = {
        method,
        token,
        form,
        bytes,
        response,
      };
      calls.push(record);
      fake.onCall?.(record);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(response));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;

  const fake: FakeSlackServer = {
    url: `http://127.0.0.1:${port}`,
    calls,
    callsTo: (method) => calls.filter((call) => call.method === method),
    respond: (method, handler) => {
      overrides.set(method, handler);
    },
    close: async () => {
      // Undici keeps keep-alive sockets open; without this, close() hangs.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return fake;
};
