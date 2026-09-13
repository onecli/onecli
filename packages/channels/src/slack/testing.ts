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
    return { ok: true };
  };

  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      const method = (req.url ?? "/").replace(/^\//, "");
      const form = Object.fromEntries(new URLSearchParams(body));
      const auth = req.headers.authorization;
      const token = auth?.startsWith("Bearer ")
        ? auth.slice("Bearer ".length)
        : null;
      const override = overrides.get(method);
      const response = override
        ? override(form)
        : defaultResponse(method, form);
      const record: RecordedSlackCall = { method, token, form, response };
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
