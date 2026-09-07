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
// Moved to @onecli/channels/slack/testing with the client it fakes;
// re-exported so this file stays the adapter tests' one fakes import.
export {
  startFakeSlackServer,
  type FakeSlackServer,
  type RecordedSlackCall,
} from "@onecli/channels/slack/testing";

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
  resolveMentions: async () => [],
  reportMentionFailures: async () => {},
  ingest: async () => ({ kind: "duplicate" as const }),
  decide: async () => ({ kind: "already_settled" as const }),
  decideReach: async () => ({ kind: "already_settled" as const }),
  decideAction: async () => ({ kind: "already_settled" as const }),
  claimPrompt: async () => true,
  recordPromptMessage: async () => {},
  settlePrompt: async () => {},
  listUnsettledPrompts: async () => [],
  advanceCursor: async () => true,
  reportApprovalHealth: async () => {},
  rotateIntegrations: async () => ({ rotated: 0, failed: 0 }),
  expireReach: async () => ({ expired: 0 }),
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
