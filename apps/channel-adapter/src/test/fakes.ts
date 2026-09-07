import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ControlPlaneClient } from "../control-plane";

/**
 * Shared test fakes. The adapter's outward seams are all HTTP or interfaces
 * by design: Slack is reached through `SLACK_API_BASE_URL` (read at call
 * time), the gateway through `gatewayUrl`, and the control plane through the
 * `ControlPlaneClient` interface — so the fakes here are a pair of real
 * `node:http` servers plus a hand-rolled client, the runner-test way. No
 * mocking framework, no patched modules.
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

// ── Fake gateway approvals server ───────────────────────────────────────────

export interface RecordedGatewayCall {
  path: string;
  token: string | null;
  /** The decoded `exclude` ids. */
  exclude: string[];
}

export interface FakeGatewayServer {
  url: string;
  calls: RecordedGatewayCall[];
  /** Answered in order; when empty, requests are HELD — the long-poll. */
  script: { status: number; body: unknown }[];
  /** Answer every currently-held long-poll. */
  releaseHeld: (status: number, body: unknown) => void;
  close: () => Promise<void>;
}

export const startFakeGatewayServer = async (): Promise<FakeGatewayServer> => {
  const calls: RecordedGatewayCall[] = [];
  const script: { status: number; body: unknown }[] = [];
  const held: ServerResponse[] = [];

  const answer = (res: ServerResponse, status: number, body: unknown): void => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    const parsed = new URL(req.url ?? "/", "http://gateway");
    const auth = req.headers.authorization;
    calls.push({
      path: parsed.pathname,
      token: auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null,
      exclude: parsed.searchParams.get("exclude")?.split(",") ?? [],
    });
    const next = script.shift();
    if (next) answer(res, next.status, next.body);
    // The real gateway holds ~30s when nothing is pending; holding here is
    // also what keeps the manager's success path from hot-spinning in tests.
    else held.push(res);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    script,
    releaseHeld: (status, body) => {
      for (const res of held.splice(0)) answer(res, status, body);
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

// ── Fake control plane ──────────────────────────────────────────────────────

/** Benign defaults for every door; override what the test scripts. */
export const createFakeControlPlane = (
  overrides: Partial<ControlPlaneClient> = {},
): ControlPlaneClient => ({
  register: async () => "adapter-1",
  getConfig: async () => null,
  getWork: async () => ({ finished: [] }),
  ingest: async () => ({ kind: "duplicate" as const }),
  decide: async () => ({ kind: "already_settled" as const }),
  decideReach: async () => ({ kind: "already_settled" as const }),
  claimPrompt: async () => true,
  recordPromptMessage: async () => {},
  settlePrompt: async () => {},
  listUnsettledPrompts: async () => [],
  advanceCursor: async () => true,
  reportApprovalHealth: async () => {},
  rotateIntegrations: async () => ({ rotated: 0, failed: 0 }),
  readTranscript: async () => ({ events: [], nextSince: 0, hasMore: false }),
  ...overrides,
});

// ── Event-loop helpers ──────────────────────────────────────────────────────

/**
 * Spin the REAL event loop until the predicate holds. Built on setImmediate
 * so it keeps working while vi.useFakeTimers holds setTimeout hostage (the
 * approvals tests fake only the timer families and advance them by hand).
 */
export const waitReal = async (
  predicate: () => boolean,
  label: string,
): Promise<void> => {
  // Deadline in REAL time, never event-loop turns: the approvals tests fake
  // the setTimeout/setInterval families but leave Date real, and a turn-count
  // bound collapses to a few milliseconds of wall clock on a loaded CI box —
  // starving the real HTTP round-trips these waits exist for (the exact CI
  // flake this replaced).
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

/** A fixed number of event-loop turns — for asserting that NOTHING happens. */
export const settle = async (turns = 40): Promise<void> => {
  for (let i = 0; i < turns; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};
