import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_RESUME_GRACE_MS,
  TURN_FAILURE_CODES,
} from "@onecli/agent-protocol";
import type {
  RunnerEvent,
  RunnerSandboxChannel,
  RunnerWorkItem,
  SandboxStartPayload,
  WorkItem,
} from "@onecli/agent-protocol";
import type { RunnerConfig } from "./config";
import { ControlPlaneError } from "./control-plane";
import type { ControlPlaneClient } from "./control-plane";
import { ImageUnavailableError, SandboxCapacityError } from "./backend/types";
import { createFakeBackend, type FakeBackend } from "./backend/fake";
import {
  createRunner,
  noProxyForRunner,
  payloadHash,
  type Runner,
} from "./runner";
import type { RunnerWsServer } from "./ws/server";

/**
 * The runner loop against the fake backend — no daemon, no images, no
 * privileges. These are the laws that decide whether an agent's computer
 * behaves: start/stop, recreate-vs-restart on a credential change, capacity,
 * failure reporting, and reconcile (which IS the teardown path).
 */

const config: RunnerConfig = {
  token: "rnr_test",
  controlPlaneUrl: "http://localhost:10256",
  name: "test runner",
  replicaName: "pod-test",
  backend: "fake",
  agentImage: "onecli-agent:test",
  sandboxNetwork: "onecli-sandboxes",
  networkInternal: true,
  wsPort: 8484,
  advertisedHost: "runner",
  advertisedPort: 8484,
  maxSandboxes: 2,
  limits: { memoryMb: 1024, cpus: 1, pids: 256 },
  reconcileSeconds: 60,
  dockerSocket: "/var/run/docker.sock",
  sandboxExtraHosts: [],
  orphanReap: true,
  orphanGraceSeconds: 3600,
  sandboxManagerUrl: null,
  sandboxManagerToken: null,
  sessionKey: null,
  cloudParkWaitSeconds: 120,
  cloudWakeWaitSeconds: 900,
  cloudImageWaitSeconds: 240,
  lifecycleConcurrency: 1,
  portApi: null,
  noProxyLoopback: true,
};

const payload = (
  overrides: Partial<SandboxStartPayload> = {},
): SandboxStartPayload => ({
  env: {
    HTTPS_PROXY: "http://x:aoc_token@gateway:10255",
    ANTHROPIC_API_KEY: "placeholder",
  },
  files: [{ containerPath: "/tmp/onecli-gateway-ca.pem", content: "PEM-BODY" }],
  model: "claude-opus-5",
  harness: "jcode",
  instructions: "Be useful.",
  agentName: "Ada",
  warnings: [],
  ...overrides,
});

const startItem = (
  sandboxId = "sb-1",
  overrides: Partial<SandboxStartPayload> = {},
): RunnerWorkItem => ({
  kind: "sandbox.start",
  sandboxId,
  agentId: "ag-1",
  payload: payload(overrides),
});

let backend: FakeBackend;
let posted: RunnerEvent[];
let queued: RunnerWorkItem[];
let expectedSandboxIds: string[];
/** Per-sandbox control-plane statuses; undefined = an old control plane. */
let expectedStatuses: Record<string, string> | undefined;
/** Per-sandbox channel facts the control plane answers (the reconciler's
 * input); a sandbox without an entry reads as an unrecorded channel. */
let channelFacts: Record<string, RunnerSandboxChannel>;
/** Whether the control plane names this copy the reconciler. */
let reconciler: boolean;
/** The role read's answer; `undefined` = an api too old to answer it. */
let roleAnswer: () => Promise<boolean | undefined>;
let listings: number;
/** Every spawn the runner recorded with the control plane, in order. */
let spawns: Array<{
  sandboxId: string;
  containerRef: string;
  tokenHash: string;
}>;
/** The control plane's answer to the next spawn records. */
let spawnAccepted: boolean;
/** Stray-stop claims, and the control plane's answer to them. */
let strayClaims: Array<{ sandboxId: string; containerRef: string }>;
let strayClaimAccepted: boolean;
let retired: number;
/** sandboxId → what the runner pushed down its control channel. */
let delivered: Map<string, WorkItem[]>;
/** Sandboxes with a live socket on this copy; anything else has none. */
let connected: Set<string>;
let drained: number;
/** The listener the runner registered for a supervisor socket closing. */
let onSocketClosed: (sandboxId: string, containerRef: string) => void;
let controlPlane: ControlPlaneClient;
let wsServer: RunnerWsServer;
let runner: Runner;

beforeEach(() => {
  backend = createFakeBackend();
  posted = [];
  queued = [];
  expectedSandboxIds = [];
  expectedStatuses = undefined;
  channelFacts = {};
  reconciler = true;
  roleAnswer = async () => reconciler;
  listings = 0;
  spawns = [];
  spawnAccepted = true;
  strayClaims = [];
  strayClaimAccepted = true;
  retired = 0;
  delivered = new Map();
  connected = new Set();
  drained = 0;

  controlPlane = {
    register: async () => ({ runnerId: "r-1", replicaId: "copy-1" }),
    pollWork: async () => queued.splice(0, queued.length),
    postEvents: async (events) => {
      posted.push(...events);
    },
    heartbeat: async () => {},
    listAssignedSandboxes: async () => {
      listings += 1;
      return {
        sandboxIds: expectedSandboxIds,
        ...(expectedStatuses && { statuses: expectedStatuses }),
        channels: channelFacts,
        reconciler,
      };
    },
    isReconciler: () => roleAnswer(),
    // Default: everything asked about exists (nothing is an orphan), so the
    // sweep is inert unless a test arms it. orphan-sweep.test.ts overrides.
    checkSandboxIds: async () => [],
    sandboxAllowedPorts: async () => [],
    toolCall: async () => ({ ok: true, result: null }),
    memoryWrite: async () => ({ ok: true }),
    uploadAttachment: async () => ({ ok: true, attachmentId: "att-fake" }),
    fetchAttachment: async () => Buffer.alloc(0),
    recordSpawn: async (sandboxId, spawn) => {
      spawns.push({ sandboxId, ...spawn });
      return spawnAccepted;
    },
    claimChannel: async () => null,
    releaseChannel: async () => undefined,
    claimStrayStop: async (sandboxId, containerRef) => {
      strayClaims.push({ sandboxId, containerRef });
      return strayClaimAccepted;
    },
    retire: async () => {
      retired += 1;
    },
  };

  wsServer = {
    resumable: true,
    onDisconnect: (listener) => {
      onSocketClosed = listener;
    },
    connection: (sandboxId) =>
      connected.has(sandboxId)
        ? {
            sandboxId,
            send: (item: WorkItem) => {
              delivered.set(sandboxId, [
                ...(delivered.get(sandboxId) ?? []),
                item,
              ]);
            },
          }
        : undefined,
    containerRefOf: () => undefined,
    listen: async () => {},
    boundPort: () => 0,
    drain: async () => {
      drained += 1;
    },
    close: async () => {},
    crash: async () => {},
  };

  runner = createRunner({ config, backend, controlPlane, wsServer });
});

/** The control plane's channel facts for one sandbox. */
const facts = (
  channel: string,
  since: number | null,
  containerRef: string | null,
): RunnerSandboxChannel => ({ channel, since, containerRef });

/**
 * `tick` only ENQUEUES — the executor runs items on per-sandbox
 * chains. Driving a poll deterministically means ticking and then settling.
 */
const drive = async (): Promise<void> => {
  await runner.tick(0);
  await runner.settle();
};

describe("start", () => {
  it("provisions a home, creates the container, and starts it", async () => {
    queued.push(startItem());
    await drive();

    const record = backend.sandboxes.get("sb-1");
    expect(record?.running).toBe(true);
    expect(record?.spec.homeRef).toBe("fake-home-sb-1");
    expect(record?.spec.image).toBe("onecli-agent:test");
    expect(record?.spec.limits).toEqual(config.limits);
  });

  it("records the spawn with the control plane (container + token hash) before the container starts, so ANY copy can admit its first connect", async () => {
    let startedWhenRecorded: boolean | undefined;
    controlPlane.recordSpawn = async (sandboxId, spawn) => {
      startedWhenRecorded = backend.sandboxes.get(sandboxId)?.running;
      spawns.push({ sandboxId, ...spawn });
      return true;
    };
    queued.push(startItem());
    await drive();

    const record = backend.sandboxes.get("sb-1");
    const token = record?.spec.env.SANDBOX_WS_TOKEN ?? "";
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(spawns).toEqual([
      {
        sandboxId: "sb-1",
        containerRef: record?.containerRef,
        tokenHash: createHash("sha256").update(token).digest("hex"),
      },
    ]);
    // Only the hash leaves the copy, and it is recorded BEFORE the start.
    expect(JSON.stringify(spawns)).not.toContain(token);
    expect(startedWhenRecorded).toBe(false);
  });

  it("stands down when the control plane refuses the spawn (the start no longer applies): removes the container, reports nothing", async () => {
    spawnAccepted = false;
    queued.push(startItem());
    await drive();

    expect(backend.sandboxes.get("sb-1")).toBeUndefined();
    // Only the pre-create progress report; nothing about the stood-down
    // container (the row belongs to whoever owns it now).
    expect(posted.filter((e) => "containerRef" in e && e.containerRef)).toEqual(
      [],
    );
    expect(
      posted.some((e) => e.kind === "sandbox.status" && e.status === "failed"),
    ).toBe(false);
  });

  it("a stood-down start gives its capacity slot back", async () => {
    // A refused spawn holds nothing; keeping its admission would refuse the
    // next admissible start at_capacity on a full copy. MUTATION-PROOF: keep
    // the slot and sb-2 is refused.
    runner = createRunner({
      config: { ...config, maxSandboxes: 1 },
      backend,
      controlPlane,
      wsServer,
    });
    spawnAccepted = false;
    queued.push(startItem("sb-1"));
    await drive();
    spawnAccepted = true;
    queued.push(startItem("sb-2"));
    await drive();

    expect(backend.sandboxes.get("sb-2")?.running).toBe(true);
  });

  it("fails the start, and removes the container, when the spawn cannot be recorded at all", async () => {
    controlPlane.recordSpawn = async () => {
      throw new ControlPlaneError(503, "down");
    };
    queued.push(startItem());
    await drive();

    expect(backend.sandboxes.get("sb-1")).toBeUndefined();
    expect(posted.at(-1)).toMatchObject({
      kind: "sandbox.status",
      sandboxId: "sb-1",
      status: "failed",
      reasonCode: "start_failed",
    });
  });

  it("resolves the home by provisioning it (an idempotent ensure), never by enumerating every home, a cost that grows with the fleet", async () => {
    const startWithEnumerationBroken = async () => {
      backend.failNext("listHomes");
      queued.push(startItem());
      await drive();
      expect(posted.at(-1)).toMatchObject({
        kind: "sandbox.status",
        sandboxId: "sb-1",
        status: "starting",
        homeRef: "fake-home-sb-1",
      });
    };
    // A brand-new home, then a wake of that SAME (now existing) home.
    await startWithEnumerationBroken();
    await startWithEnumerationBroken();
    expect(backend.sandboxes.get("sb-1")?.spec.homeRef).toBe("fake-home-sb-1");
  });

  it("wakes the home exactly once per start, handing it the payload's workspace (the placement a snapshot backend births a brand-new home from), on a first start and a recreate alike", async () => {
    queued.push(startItem("sb-1", { workspaceId: "ws-1" }));
    await drive();
    expect(backend.wakes).toEqual([
      { ref: "fake-home-sb-1", workspaceId: "ws-1" },
    ]);

    // A start of an EXISTING container recreates it (fresh token); the
    // home is still woken first, once, with the same placement.
    queued.push(startItem("sb-1", { workspaceId: "ws-1" }));
    await drive();
    expect(backend.wakes).toEqual([
      { ref: "fake-home-sb-1", workspaceId: "ws-1" },
      { ref: "fake-home-sb-1", workspaceId: "ws-1" },
    ]);
  });

  it("delivers the CA file into the sandbox, never as a mount", async () => {
    queued.push(startItem());
    await drive();

    expect(backend.sandboxes.get("sb-1")?.spec.files).toEqual([
      { containerPath: "/tmp/onecli-gateway-ca.pem", content: "PEM-BODY" },
    ]);
  });

  it("passes the agent's model, harness, brief and NAME as environment", async () => {
    // The name rides along because the sandbox states its own identity — an
    // unnamed agent falls back on whatever the harness calls itself.
    queued.push(startItem());
    await drive();

    expect(backend.sandboxes.get("sb-1")?.spec.env).toMatchObject({
      AGENT_MODEL: "claude-opus-5",
      AGENT_HARNESS: "jcode",
      AGENT_INSTRUCTIONS: "Be useful.",
      AGENT_NAME: "Ada",
    });
    // No presences composed → no variable (the supervisor reads absence as
    // "none"); an older control plane that never sends the field looks the
    // same.
    expect(backend.sandboxes.get("sb-1")?.spec.env).not.toHaveProperty(
      "AGENT_CHANNELS",
    );
  });

  it("passes the agent's channel presences as JSON in AGENT_CHANNELS", async () => {
    const channels = [
      {
        provider: "slack",
        status: "active" as const,
        handle: "ada",
        workspaceName: "Acme",
      },
    ];
    queued.push(startItem("sb-1", { channels }));
    await drive();

    const env = backend.sandboxes.get("sb-1")?.spec.env ?? {};
    expect(JSON.parse(env.AGENT_CHANNELS ?? "null")).toEqual(channels);
    // An empty list is a real value: "no presences", sent as such.
    queued.push(startItem("sb-2", { channels: [] }));
    await drive();
    expect(backend.sandboxes.get("sb-2")?.spec.env.AGENT_CHANNELS).toBe("[]");
  });

  it("turns the hosted agent desktop on only for the cloud backend that carries port streams", async () => {
    const portApi = {
      host: "0.0.0.0",
      port: 8485,
      token: "port-api-secret",
      advertisedUrl: "http://10.0.0.7:8485",
    };
    const envFor = async (overrides: Partial<RunnerConfig>) => {
      backend = createFakeBackend();
      runner = createRunner({
        config: { ...config, ...overrides },
        backend,
        controlPlane,
        wsServer,
      });
      queued.push(startItem("sb-1"));
      await drive();
      return backend.sandboxes.get("sb-1")?.spec.env ?? {};
    };
    expect(
      (await envFor({ backend: "cloud", portApi })).RUNNER_HOSTED_DESKTOP,
    ).toBe("1");
    // A self-hosted runner (docker, kubernetes), even with port streams,
    // and a cloud runner that cannot carry the screen: the plain desktop.
    for (const overrides of [
      { backend: "docker", portApi },
      { backend: "kubernetes", portApi },
      { backend: "cloud", portApi: null },
    ]) {
      expect(await envFor(overrides)).not.toHaveProperty(
        "RUNNER_HOSTED_DESKTOP",
      );
    }
  });

  it("gives the sandbox a fresh single-use control-channel token and the ADVERTISED runner URL", async () => {
    runner = createRunner({
      config: { ...config, wsPort: 9001, advertisedPort: 8484 },
      backend,
      controlPlane,
      wsServer,
    });
    queued.push(startItem("sb-1"), startItem("sb-2"));
    await drive();

    const env = backend.sandboxes.get("sb-1")?.spec.env ?? {};
    // Behind a balancer the sandbox dials the balancer's port, not the
    // copy's own listen port.
    expect(env.RUNNER_WS_URL).toBe("ws://runner:8484");
    expect(env.SANDBOX_ID).toBe("sb-1");
    expect(env.SANDBOX_WS_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(env.SANDBOX_WS_TOKEN).not.toContain("sb-1");
    expect(backend.sandboxes.get("sb-2")?.spec.env.SANDBOX_WS_TOKEN).not.toBe(
      env.SANDBOX_WS_TOKEN,
    );
  });

  it("reports starting with the refs, and NOT running (that is the supervisor's word)", async () => {
    queued.push(startItem());
    await drive();

    expect(posted.map((event) => event.kind)).toEqual([
      "sandbox.status",
      "sandbox.status",
    ]);
    expect(
      posted.every((event) => "status" in event && event.status === "starting"),
    ).toBe(true);
    expect(
      posted.some((event) => "containerRef" in event && event.containerRef),
    ).toBe(true);
  });

  it("reports failed when the backend cannot create the container", async () => {
    backend.failNext("create");
    queued.push(startItem());
    await drive();

    const last = posted.at(-1);
    expect(last).toMatchObject({
      kind: "sandbox.status",
      status: "failed",
      // The generic classification — the control plane's copy map treats
      // anything it does not recognize the same way.
      reasonCode: "start_failed",
    });
  });

  it("classifies a missing image as image_unavailable", async () => {
    backend.failNext(
      "create",
      new ImageUnavailableError("onecli-agent:test", "pull failed: not found"),
    );
    queued.push(startItem());
    await drive();

    expect(posted.at(-1)).toMatchObject({
      kind: "sandbox.status",
      status: "failed",
      reasonCode: "image_unavailable",
    });
  });

  it("classifies a substrate capacity refusal as at_capacity — the workspace quota's honest copy (step 6)", async () => {
    backend.failNext(
      "create",
      new SandboxCapacityError("workspace ws-ws1 is at its home quota"),
    );
    queued.push(startItem());
    await drive();

    expect(posted.at(-1)).toMatchObject({
      kind: "sandbox.status",
      status: "failed",
      reasonCode: "at_capacity",
    });
  });

  it("reports failed — not a crashed tick — when the daemon dies before create", async () => {
    // The pre-try hole this guards: `listSandboxes` used to run OUTSIDE the
    // failure reporting, so a dead daemon threw out of the whole tick,
    // nothing was posted, and the sandbox sat `starting` until the 300s
    // stale claim instead of `failed` with a reason.
    backend.failNext("list", new Error("connect ENOENT /var/run/docker.sock"));
    queued.push(startItem());
    await drive();

    expect(posted.at(-1)).toMatchObject({
      kind: "sandbox.status",
      sandboxId: "sb-1",
      status: "failed",
      reasonCode: "start_failed",
    });
  });

  it("refuses to exceed its concurrent-sandbox cap", async () => {
    queued.push(startItem("sb-1"), startItem("sb-2"));
    await drive();
    posted.length = 0;

    queued.push(startItem("sb-3"));
    await drive();

    expect(posted.at(-1)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("capacity"),
      reasonCode: "at_capacity",
    });
    expect(backend.sandboxes.has("sb-3")).toBe(false);
  });
});

describe("every start hands the sandbox a live control-channel credential", () => {
  it("RECREATES a parked container on wake, with a fresh bootstrap token", async () => {
    // The token is single-use and baked into the container's environment, so
    // restarting the same container would leave a sandbox that runs but can
    // never authenticate — and the control plane would re-dispatch it forever.
    queued.push(startItem());
    await drive();
    const firstRef = backend.sandboxes.get("sb-1")?.containerRef;
    const firstToken = backend.sandboxes.get("sb-1")?.spec.env.SANDBOX_WS_TOKEN;

    await backend.stopSandbox(firstRef!);
    queued.push(startItem());
    await drive();

    const record = backend.sandboxes.get("sb-1");
    expect(record?.containerRef).not.toBe(firstRef);
    expect(record?.spec.env.SANDBOX_WS_TOKEN).not.toBe(firstToken);
    expect(record?.running).toBe(true);
  });

  it("recreates the container when the payload changed (a rotated token)", async () => {
    queued.push(startItem());
    await drive();
    const firstRef = backend.sandboxes.get("sb-1")?.containerRef;

    queued.push(
      startItem("sb-1", {
        env: {
          HTTPS_PROXY: "http://x:aoc_ROTATED@gateway:10255",
          ANTHROPIC_API_KEY: "placeholder",
        },
      }),
    );
    await drive();

    expect(backend.sandboxes.get("sb-1")?.containerRef).not.toBe(firstRef);
    expect(backend.sandboxes.get("sb-1")?.spec.env.HTTPS_PROXY).toContain(
      "aoc_ROTATED",
    );
  });

  it("keeps the SAME home across a recreate (the durable disk)", async () => {
    queued.push(startItem());
    await drive();

    queued.push(startItem("sb-1", { instructions: "Changed brief." }));
    await drive();

    expect(backend.sandboxes.get("sb-1")?.spec.homeRef).toBe("fake-home-sb-1");
    expect(backend.homes.size).toBe(1);
  });

  it("hashes payloads stably regardless of key order", () => {
    const a = payload({ env: { A: "1", B: "2" } });
    const b = payload({ env: { B: "2", A: "1" } });
    expect(payloadHash(a)).toBe(payloadHash(b));
  });

  it("ignores file CONTENT, which is re-stamped on every build", () => {
    // A credential stub carries a fresh timestamp each time it is composed;
    // hashing its bytes would make every payload look changed.
    const a = payload({
      files: [{ containerPath: "/home/node/.codex/auth.json", content: "t=1" }],
    });
    const b = payload({
      files: [{ containerPath: "/home/node/.codex/auth.json", content: "t=2" }],
    });
    expect(payloadHash(a)).toBe(payloadHash(b));
  });

  it("still moves when a real credential changes (it lives in env)", () => {
    const a = payload({
      env: { HTTPS_PROXY: "http://x:aoc_one@gateway:10255" },
    });
    const b = payload({
      env: { HTTPS_PROXY: "http://x:aoc_two@gateway:10255" },
    });
    expect(payloadHash(a)).not.toBe(payloadHash(b));
  });
});

describe("stop", () => {
  it("stops the container but keeps the home (sleep, not delete)", async () => {
    queued.push(startItem());
    await drive();
    posted.length = 0;

    queued.push({ kind: "sandbox.stop", sandboxId: "sb-1" });
    await drive();

    expect(backend.sandboxes.get("sb-1")?.running).toBe(false);
    expect(backend.homes.get("sb-1")).toBe("fake-home-sb-1");
    expect(posted).toEqual([
      { kind: "sandbox.status", sandboxId: "sb-1", status: "stopped" },
    ]);
  });

  it("parks the sandbox's own home by NAME, never by enumerating every home (a fleet-sized listing on the stop path)", async () => {
    queued.push(startItem());
    await drive();
    posted.length = 0;
    backend.failNext("listHomes");

    queued.push({ kind: "sandbox.stop", sandboxId: "sb-1" });
    await drive();

    expect(backend.parks).toEqual(["fake-home-sb-1"]);
    expect(posted).toEqual([
      { kind: "sandbox.status", sandboxId: "sb-1", status: "stopped" },
    ]);
  });

  it("treats a stop for an unknown sandbox as already stopped", async () => {
    queued.push({ kind: "sandbox.stop", sandboxId: "sb-ghost" });
    await drive();

    expect(posted).toEqual([
      { kind: "sandbox.status", sandboxId: "sb-ghost", status: "stopped" },
    ]);
  });
});

describe("reconcile (the teardown path)", () => {
  it("destroys a sandbox the control plane no longer knows about", async () => {
    queued.push(startItem("sb-doomed"));
    await drive();
    expect(backend.sandboxes.has("sb-doomed")).toBe(true);

    expectedSandboxIds = [];
    await runner.reconcile();

    expect(backend.sandboxes.has("sb-doomed")).toBe(false);
    expect(backend.homes.has("sb-doomed")).toBe(false);
  });

  it("leaves a sandbox the control plane still expects", async () => {
    queued.push(startItem("sb-keep"));
    await drive();

    expectedSandboxIds = ["sb-keep"];
    await runner.reconcile();

    expect(backend.sandboxes.has("sb-keep")).toBe(true);
    expect(backend.homes.has("sb-keep")).toBe(true);
  });

  it("reaps an orphaned home whose container is already gone", async () => {
    await backend.provisionHome("sb-leftover");
    expectedSandboxIds = [];

    await runner.reconcile();

    expect(backend.homes.has("sb-leftover")).toBe(false);
  });

  it("runs on start, so a crashed runner cleans up on next boot", async () => {
    await backend.provisionHome("sb-crashed");
    expectedSandboxIds = [];

    await runner.start();

    expect(backend.homes.has("sb-crashed")).toBe(false);
    await runner.stop();
  });
});

/**
 * Reconcile reads the CONTROL PLANE's channel facts, never this process's
 * memory: with several copies behind one address, a sandbox's socket may be
 * held by any of them, and a copy that restarted remembers nothing. Every
 * report names the container it is about, so a late one never moves a
 * sandbox whose container was replaced meanwhile.
 */
describe("reconcile verdicts come from the control plane's channel facts", () => {
  /** sb-1 started and running; its channel facts set by the caller. */
  const started = async (): Promise<string> => {
    queued.push(startItem("sb-1"));
    await drive();
    expectedSandboxIds = ["sb-1"];
    expectedStatuses = { "sb-1": "running" };
    posted.length = 0;
    return backend.sandboxes.get("sb-1")!.containerRef;
  };
  const stopped = (containerRef: string): RunnerEvent => ({
    kind: "sandbox.status",
    sandboxId: "sb-1",
    status: "stopped",
    observedContainerRef: containerRef,
  });

  it("says nothing while ANOTHER copy holds the socket, though this copy has none", async () => {
    // The multi-copy law: no socket here is not no socket anywhere.
    const ref = await started();
    channelFacts = { "sb-1": facts("held", Date.now(), ref) };

    await runner.reconcile();

    expect(connected.has("sb-1")).toBe(false);
    expect(posted).toEqual([]);
  });

  it("says nothing about a sandbox still dialling in", async () => {
    const ref = await started();
    channelFacts = { "sb-1": facts("awaiting", Date.now(), ref) };
    await runner.reconcile();
    expect(posted).toEqual([]);
  });

  it("waits out the resume grace after a drop, then reports it stopped, stamped with its container", async () => {
    const ref = await started();
    channelFacts = { "sb-1": facts("dropped", Date.now() - 1_000, ref) };
    await runner.reconcile();
    expect(posted).toEqual([]);

    channelFacts = {
      "sb-1": facts("dropped", Date.now() - SESSION_RESUME_GRACE_MS - 1, ref),
    };
    await runner.reconcile();
    expect(posted).toEqual([stopped(ref)]);
  });

  it("gives a sandbox whose holder died the inherited grace, then reports it", async () => {
    runner = createRunner({
      config,
      backend,
      controlPlane,
      wsServer,
      inheritedResumeGraceMs: 30,
    });
    const ref = await started();
    channelFacts = { "sb-1": facts("lost", Date.now() - 60_000, ref) };

    await runner.reconcile();
    expect(posted).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await runner.reconcile();
    expect(posted).toEqual([stopped(ref)]);
  });

  it("restarts the inherited grace when it loses the reconciler role and gets it back", async () => {
    // Another copy reconciled meanwhile; this one watched nothing. Its own
    // clock must not count time it did not spend watching.
    // MUTATION-PROOF: keep reconcilerSince across a lost role and the last
    // expect fails.
    runner = createRunner({
      config,
      backend,
      controlPlane,
      wsServer,
      inheritedResumeGraceMs: 30,
    });
    const ref = await started();
    channelFacts = { "sb-1": facts("lost", Date.now() - 60_000, ref) };
    await runner.reconcile();
    reconciler = false;
    await new Promise((resolve) => setTimeout(resolve, 60));
    await runner.reconcile();
    reconciler = true;

    await runner.reconcile();
    expect(posted).toEqual([]);
  });

  it("ships a 3 min inherited grace: a lost holder's sandbox is left alone at 179 s and reported at 181 s", async () => {
    // The DEFAULT, no `inheritedResumeGraceMs` override (the runner from
    // beforeEach). Fails if the default regresses to the supervisor's whole
    // ~15.5 min reconnect budget, the bug the 3 min grace was set for. The
    // end-to-end leg runs a shortened grace; this is the default's one pin.
    const ref = await started();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = Date.now();
      channelFacts = { "sb-1": facts("lost", t0 - 60_000, ref) };
      // The first pass as reconciler anchors the grace at t0.
      await runner.reconcile();
      expect(posted).toEqual([]);

      vi.setSystemTime(t0 + 179_000);
      await runner.reconcile();
      expect(posted).toEqual([]);

      vi.setSystemTime(t0 + 181_000);
      await runner.reconcile();
      expect(posted).toEqual([stopped(ref)]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an unrecorded channel at once when no supervisor could resume (no keyring here)", async () => {
    runner = createRunner({
      config,
      backend,
      controlPlane,
      wsServer: { ...wsServer, resumable: false },
    });
    const ref = await started();
    await runner.reconcile();
    expect(posted).toEqual([stopped(ref)]);
  });

  it("gives no grace to a container spawned WITHOUT sessions, even under a keyed copy: its supervisor can never resume", async () => {
    queued.push(startItem("sb-1"));
    runner = createRunner({
      config,
      backend,
      controlPlane,
      wsServer: { ...wsServer, resumable: false },
    });
    await drive();
    expect(backend.sandboxes.get("sb-1")!.spec.resumable).toBe(false);
    const ref = backend.sandboxes.get("sb-1")!.containerRef;
    expectedSandboxIds = ["sb-1"];
    posted.length = 0;
    runner = createRunner({ config, backend, controlPlane, wsServer });

    await runner.reconcile();

    expect(posted).toEqual([stopped(ref)]);
  });

  it("leaves a container alone when the facts are about a NEWER one (a start replaced it)", async () => {
    await started();
    channelFacts = {
      "sb-1": facts(
        "dropped",
        Date.now() - SESSION_RESUME_GRACE_MS - 1,
        "ct-new",
      ),
    };
    await runner.reconcile();
    expect(posted).toEqual([]);
  });

  it("reports a DEAD container at once, grace or no grace, and only once", async () => {
    // A dead container has no supervisor to come back. MUTATION-PROOF: drop
    // the reportedDead dedupe and the second expect fails.
    const ref = await started();
    channelFacts = { "sb-1": facts("dropped", Date.now() - 1_000, ref) };
    backend.sandboxes.get("sb-1")!.running = false;

    await runner.reconcile();
    expect(posted).toEqual([stopped(ref)]);
    posted.length = 0;
    await runner.reconcile();
    expect(posted).toEqual([]);
  });

  it("leaves a dead container whose socket is still HELD: its holder sees the close", async () => {
    const ref = await started();
    channelFacts = { "sb-1": facts("held", Date.now(), ref) };
    backend.sandboxes.get("sb-1")!.running = false;
    await runner.reconcile();
    expect(posted).toEqual([]);
  });
});

/**
 * A socket closes: was it the container dying? The copy that held the
 * socket looks at THAT container at once. Dead: it is reported stopped now
 * (stamped with that container), so the next message wakes the sandbox on
 * the ordinary path instead of waiting for a socket that cannot come back
 * until the reconciler's next pass. Alive: the supervisor is reconnecting
 * (to this copy or another), and nothing is said.
 */
describe("a supervisor socket closing", () => {
  beforeEach(() => {
    runner = createRunner({
      config,
      backend,
      controlPlane,
      wsServer,
      closedChannelLookMs: 5,
    });
  });

  const started = async (): Promise<string> => {
    await runner.start();
    queued.push(startItem("sb-1"));
    await drive();
    posted.length = 0;
    return backend.sandboxes.get("sb-1")!.containerRef;
  };

  it("reports a container that died with it, at once and stamped with it", async () => {
    // MUTATION-PROOF: drop the listener (the report never comes), or report
    // without the container stamp (it could knock down a fresh start).
    const ref = await started();
    backend.sandboxes.get("sb-1")!.running = false;

    onSocketClosed("sb-1", ref);
    await runner.settle();

    expect(posted).toEqual([
      {
        kind: "sandbox.status",
        sandboxId: "sb-1",
        status: "stopped",
        observedContainerRef: ref,
      },
    ]);
    // One report per container: the reconciler's next pass stays quiet.
    expectedSandboxIds = ["sb-1"];
    expectedStatuses = { "sb-1": "running" };
    channelFacts = { "sb-1": facts("dropped", Date.now(), ref) };
    posted.length = 0;
    await runner.reconcile();
    expect(posted).toEqual([]);
    await runner.stop();
  });

  it("says nothing when the container is alive (the supervisor is reconnecting)", async () => {
    const ref = await started();
    onSocketClosed("sb-1", ref);
    await runner.settle();
    expect(posted).toEqual([]);
    await runner.stop();
  });

  it("catches a container still reading `running` at the close that dies a moment later", async () => {
    // The real ordering: the socket closes BEFORE the substrate reads the
    // killed container as exited. One look would call it alive and the next
    // message would wait for the reconciler. MUTATION-PROOF: look once.
    const ref = await started();
    const record = backend.sandboxes.get("sb-1")!;
    const list = backend.listSandboxes.bind(backend);
    let looks = 0;
    backend.listSandboxes = async () => {
      looks += 1;
      if (looks === 2) record.running = false;
      return list();
    };

    onSocketClosed("sb-1", ref);
    await runner.settle();

    expect(posted).toEqual([
      {
        kind: "sandbox.status",
        sandboxId: "sb-1",
        status: "stopped",
        observedContainerRef: ref,
      },
    ]);
    await runner.stop();
  });

  it("stops looking once the supervisor is back on this copy", async () => {
    const ref = await started();
    const list = backend.listSandboxes.bind(backend);
    let looks = 0;
    backend.listSandboxes = async () => {
      looks += 1;
      connected.add("sb-1");
      return list();
    };
    onSocketClosed("sb-1", ref);
    await runner.settle();
    expect(looks).toBe(1);
    expect(posted).toEqual([]);
    await runner.stop();
  });

  it("says nothing while a stop of its own is in flight for that sandbox", async () => {
    // The stop speaks for the sandbox. The close lands while the stop is
    // mid-way (its listing held). MUTATION-PROOF: drop the in-flight-stop
    // fence and the check reports the container ahead of the stop.
    const ref = await started();
    const release = backend.holdNext("list");
    queued.push({ kind: "sandbox.stop", sandboxId: "sb-1", containerRef: ref });
    await runner.tick(0);
    backend.sandboxes.get("sb-1")!.running = false;
    onSocketClosed("sb-1", ref);
    release();
    await runner.settle();
    expect(posted.filter((e) => "observedContainerRef" in e)).toEqual([]);
    await runner.stop();
  });

  it("says nothing while a start of its own is replacing that container", async () => {
    // A start recreates the container: the old one is gone and its socket
    // closes with it. MUTATION-PROOF: drop the start's in-flight mark and
    // the check reports the old container as gone mid-start.
    const ref = await started();
    const release = backend.holdNext("create");
    queued.push(startItem("sb-1"));
    await runner.tick(0);
    await vi.waitFor(() => expect(backend.sandboxes.has("sb-1")).toBe(false));
    onSocketClosed("sb-1", ref);
    await new Promise((resolve) => setTimeout(resolve, 40));
    release();
    await runner.settle();
    expect(posted.filter((e) => "observedContainerRef" in e)).toEqual([]);
    await runner.stop();
  });

  it("stays quiet for a start queued behind its stop once the stop is done", async () => {
    // Both in flight at once: the stop finishing must not clear the start's
    // mark. MUTATION-PROOF: track a set instead of a count and the check
    // reports the old container while the start is replacing it.
    const ref = await started();
    const releaseStop = backend.holdNext("stop");
    queued.push({ kind: "sandbox.stop", sandboxId: "sb-1", containerRef: ref });
    await runner.tick(0);
    const releaseCreate = backend.holdNext("create");
    queued.push(startItem("sb-1"));
    await runner.tick(0);
    releaseStop();
    await vi.waitFor(() => expect(backend.sandboxes.has("sb-1")).toBe(false));
    onSocketClosed("sb-1", ref);
    await new Promise((resolve) => setTimeout(resolve, 40));
    releaseCreate();
    await runner.settle();
    expect(posted.filter((e) => "observedContainerRef" in e)).toEqual([]);
    await runner.stop();
  });

  it("speaks again once its own stop and start are done", async () => {
    // MUTATION-PROOF: never clear a stop's mark and the next close of the
    // fresh container is muted for good.
    const ref = await started();
    queued.push({ kind: "sandbox.stop", sandboxId: "sb-1", containerRef: ref });
    await drive();
    queued.push(startItem("sb-1"));
    await drive();
    posted.length = 0;
    const fresh = backend.sandboxes.get("sb-1")!;
    fresh.running = false;
    onSocketClosed("sb-1", fresh.containerRef);
    await runner.settle();
    expect(posted).toEqual([
      {
        kind: "sandbox.status",
        sandboxId: "sb-1",
        status: "stopped",
        observedContainerRef: fresh.containerRef,
      },
    ]);
    await runner.stop();
  });

  it("reports a container that is GONE from the substrate (a deleted pod)", async () => {
    // A cluster backend's shape: a pod deleted out of band is not listed at
    // all, never as `running: false`. Gone is as dead as exited.
    // MUTATION-PROOF: treat an absent container as alive and nothing is
    // reported.
    const ref = await started();
    backend.sandboxes.delete("sb-1");
    onSocketClosed("sb-1", ref);
    await runner.settle();
    expect(posted).toEqual([
      {
        kind: "sandbox.status",
        sandboxId: "sb-1",
        status: "stopped",
        observedContainerRef: ref,
      },
    ]);
    await runner.stop();
  });

  it("says nothing when a newer container already replaced the one the socket was for", async () => {
    // A start recreated it; the old socket's close is history, and the new
    // container's supervisor is on its way in. MUTATION-PROOF: ignore the
    // newer container and the check reports the old one, since the newer
    // one is still booting (not `running` yet).
    await started();
    backend.sandboxes.get("sb-1")!.running = false;
    onSocketClosed("sb-1", "ct-before-the-start");
    await runner.settle();
    expect(posted).toEqual([]);
    await runner.stop();
  });

  it("spreads its looks over time, so a container that dies by the clock is caught", async () => {
    // The substrate's lag is time, not a number of reads. Looks here are
    // 5 ms apart (20 ms in all); the container dies 10 ms after the close.
    // MUTATION-PROOF: drop the wait between looks and all five land at
    // once, before it reads dead.
    const ref = await started();
    const record = backend.sandboxes.get("sb-1")!;
    const closedAt = Date.now();
    const list = backend.listSandboxes.bind(backend);
    backend.listSandboxes = async () => {
      if (Date.now() - closedAt >= 10) record.running = false;
      return list();
    };

    onSocketClosed("sb-1", ref);
    await runner.settle();

    expect(posted).toEqual([
      {
        kind: "sandbox.status",
        sandboxId: "sb-1",
        status: "stopped",
        observedContainerRef: ref,
      },
    ]);
    await runner.stop();
  });

  it("looks at many closes together with one listing per look", async () => {
    // A node lost takes many sockets at once, and each listing is a cluster
    // API call. MUTATION-PROOF: list per closed socket and the count grows
    // with the sockets.
    await runner.start();
    for (const id of ["sb-1", "sb-2"]) {
      queued.push(startItem(id));
    }
    await drive();
    posted.length = 0;
    const list = backend.listSandboxes.bind(backend);
    let listings = 0;
    backend.listSandboxes = async () => {
      listings += 1;
      return list();
    };
    const one = backend.sandboxes.get("sb-1")!;
    const two = backend.sandboxes.get("sb-2")!;
    one.running = false;
    onSocketClosed("sb-1", one.containerRef);
    onSocketClosed("sb-2", two.containerRef);
    await runner.settle();

    expect(posted).toEqual([
      {
        kind: "sandbox.status",
        sandboxId: "sb-1",
        status: "stopped",
        observedContainerRef: one.containerRef,
      },
    ]);
    // sb-2 stays running: five looks, one listing each, shared with sb-1.
    expect(listings).toBe(5);
    await runner.stop();
  });

  it("says nothing about the sockets its own shutdown closes", async () => {
    // A stopping copy hands every supervisor on: those closes are its own
    // drain. MUTATION-PROOF: check them anyway and the stop reports (and
    // lists for) every container it is handing over.
    const ref = await started();
    const list = backend.listSandboxes.bind(backend);
    let listings = 0;
    backend.listSandboxes = async () => {
      listings += 1;
      return list();
    };
    backend.sandboxes.get("sb-1")!.running = false;
    wsServer.drain = async () => {
      onSocketClosed("sb-1", ref);
    };
    await runner.stop();
    await runner.settle();
    expect(posted).toEqual([]);
    expect(listings).toBe(0);
  });

  it("gives a close that lands mid-sweep its full looks", async () => {
    // MUTATION-PROOF: end the sweep after the first close's looks and the
    // later container, which dies on its last look, is never reported.
    await runner.start();
    for (const id of ["sb-1", "sb-2"]) {
      queued.push(startItem(id));
    }
    await drive();
    posted.length = 0;
    const one = backend.sandboxes.get("sb-1")!;
    const two = backend.sandboxes.get("sb-2")!;
    const list = backend.listSandboxes.bind(backend);
    let listings = 0;
    backend.listSandboxes = async () => {
      listings += 1;
      // sb-2 closes during sb-1's second look (listing 2), so its own five
      // looks are listings 2-6; it dies on the last, after sb-1's are done.
      if (listings === 2) onSocketClosed("sb-2", two.containerRef);
      if (listings === 6) two.running = false;
      return list();
    };
    onSocketClosed("sb-1", one.containerRef);
    await runner.settle();

    expect(posted).toEqual([
      {
        kind: "sandbox.status",
        sandboxId: "sb-2",
        status: "stopped",
        observedContainerRef: two.containerRef,
      },
    ]);
    await runner.stop();
  });

  it("says nothing about a container the reconciler already reported", async () => {
    // One report per container, whichever path saw it first. MUTATION-PROOF:
    // drop the shared dedupe and the close reports it a second time.
    const ref = await started();
    backend.sandboxes.get("sb-1")!.running = false;
    expectedSandboxIds = ["sb-1"];
    expectedStatuses = { "sb-1": "running" };
    channelFacts = { "sb-1": facts("dropped", Date.now(), ref) };
    await runner.reconcile();
    expect(posted).toHaveLength(1);
    posted.length = 0;
    onSocketClosed("sb-1", ref);
    await runner.settle();
    expect(posted).toEqual([]);
    await runner.stop();
  });
});

/**
 * ONE copy reconciles (the oldest live one, named by the control plane), so
 * N copies never report, stop or reap the same object N times. The others
 * only serve sockets.
 */
describe("a copy that is not the reconciler", () => {
  it("reports, stops, reaps and sweeps nothing", async () => {
    // MUTATION-PROOF: ignore `reconciler: false` and every expect fails.
    queued.push(startItem("sb-dead"), startItem("sb-orphan"));
    await drive();
    const deadRef = backend.sandboxes.get("sb-dead")!.containerRef;
    backend.sandboxes.get("sb-dead")!.running = false;
    expectedSandboxIds = ["sb-dead", "sb-gone"];
    expectedStatuses = { "sb-dead": "running", "sb-gone": "running" };
    channelFacts = { "sb-dead": facts("dropped", Date.now(), deadRef) };
    reconciler = false;
    const checkSpy = vi.spyOn(controlPlane, "checkSandboxIds");
    posted.length = 0;

    await runner.reconcile();
    await runner.reconcile();

    expect(posted).toEqual([]);
    expect(backend.sandboxes.has("sb-orphan")).toBe(true);
    expect(backend.homes.has("sb-orphan")).toBe(true);
    expect(checkSpy).not.toHaveBeenCalled();
  });

  it("asks for its role alone and never fetches the sandbox listing", async () => {
    // The listing is every sandbox's row; a copy that will not reconcile
    // needs none of it. MUTATION-PROOF: list first (the old order) and the
    // count is one per pass.
    reconciler = false;
    await runner.reconcile();
    await runner.reconcile();
    expect(listings).toBe(0);

    reconciler = true;
    await runner.reconcile();
    expect(listings).toBe(1);
  });

  it("falls back to the listing's role when the api is too old to answer it alone", async () => {
    // A runner deployed before its api: the role read 404s (`undefined`),
    // and the listing still carries the role, as before. MUTATION-PROOF:
    // read `undefined` as "not the reconciler" and an old api leaves no
    // copy reconciling at all; read it as "the reconciler" and every copy
    // reconciles.
    roleAnswer = async () => undefined;
    queued.push(startItem("sb-dead"));
    await drive();
    const ref = backend.sandboxes.get("sb-dead")!.containerRef;
    backend.sandboxes.get("sb-dead")!.running = false;
    expectedSandboxIds = ["sb-dead"];
    expectedStatuses = { "sb-dead": "running" };
    channelFacts = { "sb-dead": facts("dropped", Date.now(), ref) };
    posted.length = 0;

    reconciler = false;
    await runner.reconcile();
    expect(listings).toBeGreaterThan(0);
    expect(posted).toEqual([]);

    reconciler = true;
    await runner.reconcile();
    expect(posted).toEqual([
      {
        kind: "sandbox.status",
        sandboxId: "sb-dead",
        status: "stopped",
        observedContainerRef: ref,
      },
    ]);
  });
});

/**
 * THE STRAY BACKSTOP. A running container with no channel whose row the
 * control plane has already parked (`stopped`/`failed`): a report would
 * change nothing (the status guard absorbs it), so the reconciler stops it
 * itself, once the control plane agrees no start has taken the sandbox.
 */
describe("a running container the control plane no longer expects to run", () => {
  /** A started sandbox whose channel dropped past the grace. */
  const zombie = async (status: string | undefined): Promise<string> => {
    queued.push(startItem("sb-1"));
    await drive();
    const ref = backend.sandboxes.get("sb-1")!.containerRef;
    expectedSandboxIds = ["sb-1"];
    expectedStatuses = status === undefined ? undefined : { "sb-1": status };
    channelFacts = {
      "sb-1": facts("dropped", Date.now() - SESSION_RESUME_GRACE_MS - 1, ref),
    };
    posted.length = 0;
    return ref;
  };

  it.each(["stopped", "failed"])(
    "is claimed, STOPPED (home parked) and reported stopped when its row reads `%s`",
    async (status) => {
      // The claim moved the row to `stopping` under this copy; the report is
      // what lands it, like any stop's. MUTATION-PROOF: drop the backstop
      // and the container stays running.
      const ref = await zombie(status);
      const stopSpy = vi.spyOn(backend, "stopSandbox");

      await runner.reconcile();
      await runner.settle();

      expect(strayClaims).toEqual([{ sandboxId: "sb-1", containerRef: ref }]);
      expect(stopSpy).toHaveBeenCalledWith(ref, "sb-1");
      expect(backend.sandboxes.get("sb-1")?.running).toBe(false);
      expect(backend.parks).toContain("fake-home-sb-1");
      expect(posted).toEqual([
        {
          kind: "sandbox.status",
          sandboxId: "sb-1",
          status: "stopped",
          observedContainerRef: ref,
        },
      ]);
    },
  );

  it("is left running when the control plane refuses the claim (a start took it), and asked about again next pass", async () => {
    // MUTATION-PROOF: stop without the claim and the container dies under
    // the start that owns it; keep the ref deduped after a refusal and the
    // second claim never comes.
    await zombie("stopped");
    strayClaimAccepted = false;
    const stopSpy = vi.spyOn(backend, "stopSandbox");

    await runner.reconcile();
    await runner.settle();
    await runner.reconcile();
    await runner.settle();

    expect(stopSpy).not.toHaveBeenCalled();
    expect(strayClaims).toHaveLength(2);
    expect(posted).toEqual([]);
  });

  it("is stopped ONCE: a pass that finds it still listed does not claim or stop it again", async () => {
    // MUTATION-PROOF: drop the per-ref dedupe and the spy sees two calls.
    const ref = await zombie("stopped");
    const stopSpy = vi.spyOn(backend, "stopSandbox");
    // The substrate keeps listing it as running after the stop returns.
    stopSpy.mockImplementation(async () => {});

    await runner.reconcile();
    await runner.settle();
    await runner.reconcile();
    await runner.settle();

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).toHaveBeenCalledWith(ref, "sb-1");
    expect(strayClaims).toHaveLength(1);
  });

  it("the REAL sequence: reported once while its row reads running, then STOPPED once the report has parked the row", async () => {
    // The report and the stop are separate acts on the same container: the
    // report's dedupe must not swallow the stop the parked row then calls
    // for (the zombie shape). MUTATION-PROOF: share one dedupe between them
    // and the container is never stopped.
    const ref = await zombie("running");
    const stopSpy = vi.spyOn(backend, "stopSandbox");

    await runner.reconcile();
    await runner.settle();
    expect(stopSpy).not.toHaveBeenCalled();
    expect(posted).toHaveLength(1);

    expectedStatuses = { "sb-1": "stopped" };
    await runner.reconcile();
    await runner.settle();

    expect(strayClaims).toEqual([{ sandboxId: "sb-1", containerRef: ref }]);
    expect(stopSpy).toHaveBeenCalledWith(ref, "sb-1");
    expect(backend.sandboxes.get("sb-1")?.running).toBe(false);
  });

  it("is tried AGAIN on the next pass when the stop itself failed", async () => {
    // MUTATION-PROOF: keep the ref deduped after a failed stop and the second
    // pass does nothing.
    await zombie("stopped");
    const stopSpy = vi.spyOn(backend, "stopSandbox");
    backend.failNext("stop");

    await runner.reconcile();
    await runner.settle();
    expect(backend.sandboxes.get("sb-1")?.running).toBe(true);
    expect(posted).toEqual([]);

    await runner.reconcile();
    await runner.settle();
    expect(stopSpy).toHaveBeenCalledTimes(2);
    expect(backend.sandboxes.get("sb-1")?.running).toBe(false);
  });

  it.each(["running", "starting", "stopping", "unprovisioned", undefined])(
    "is only REPORTED, never stopped, while its row reads `%s` (the report is what moves the row)",
    async (status) => {
      // MUTATION-PROOF: let any of these into the parked set and this stops
      // a container the control plane has not parked; a missing status (the
      // field is optional on the wire) must never read as parked.
      const ref = await zombie(status);
      const stopSpy = vi.spyOn(backend, "stopSandbox");

      await runner.reconcile();
      await runner.settle();

      expect(stopSpy).not.toHaveBeenCalled();
      expect(strayClaims).toEqual([]);
      expect(posted).toEqual([
        {
          kind: "sandbox.status",
          sandboxId: "sb-1",
          status: "stopped",
          observedContainerRef: ref,
        },
      ]);
    },
  );

  it("is left alone while a start for it is QUEUED (the start recreates it anyway)", async () => {
    // MUTATION-PROOF: drop the start fence and a second stop lands.
    await zombie("stopped");
    const stopSpy = vi.spyOn(backend, "stopSandbox");
    const release = backend.holdNext("stop");
    queued.push({ kind: "sandbox.stop", sandboxId: "sb-1" });
    await runner.tick(0);
    await vi.waitFor(() => expect(stopSpy).toHaveBeenCalledTimes(1));
    queued.push(startItem("sb-1"));
    await runner.tick(0);

    await runner.reconcile();

    release();
    await runner.settle();
    // The held stop, then the start's own recreate (stop + remove + create):
    // two calls. A reconcile-issued stop would be a third.
    expect(stopSpy).toHaveBeenCalledTimes(2);
    expect(strayClaims).toEqual([]);
  });

  it("is left alone while a start for it is EXECUTING (the old container is still listed mid-recreate)", async () => {
    // MUTATION-PROOF: drop the executing-start fence and reconcile stops the
    // container being replaced.
    const oldRef = await zombie("stopped");
    const old = backend.sandboxes.get("sb-1")!;
    const release = backend.holdNext("create");
    queued.push(startItem("sb-1"));
    await runner.tick(0);
    await vi.waitFor(() => expect(backend.sandboxes.has("sb-1")).toBe(false));
    backend.sandboxes.set("sb-1", { ...old, running: true });
    const stopSpy = vi.spyOn(backend, "stopSandbox");

    await runner.reconcile();

    release();
    await runner.settle();
    expect(stopSpy).not.toHaveBeenCalledWith(oldRef, "sb-1");
    expect(strayClaims).toEqual([]);
  });

  it("is left alone while a deliberate stop for it is QUEUED (that stop ends this very container)", async () => {
    // MUTATION-PROOF: drop the queued-stop fence and reconcile adds a third.
    await zombie("stopped");
    const stopSpy = vi.spyOn(backend, "stopSandbox");
    const release = backend.holdNext("stop");
    queued.push({ kind: "sandbox.stop", sandboxId: "sb-1" });
    await runner.tick(0);
    await vi.waitFor(() => expect(stopSpy).toHaveBeenCalledTimes(1));
    queued.push({ kind: "sandbox.stop", sandboxId: "sb-1" });
    await runner.tick(0);

    await runner.reconcile();

    release();
    await runner.settle();
    expect(stopSpy).toHaveBeenCalledTimes(2);
    expect(strayClaims).toEqual([]);
  });
});

/**
 * A copy's lifetime: it takes an identity before it admits a socket, and on
 * the way out it hands every supervisor to the other copies before giving
 * the identity up, so the sandboxes it owned pass on at once.
 */
describe("a copy's start and stop", () => {
  it("registers with its copy name and its port-API address BEFORE it listens", async () => {
    const order: string[] = [];
    const register = vi.fn(async () => {
      order.push("register");
      return { runnerId: "r-1", replicaId: "copy-1" };
    });
    const copy = createRunner({
      config: {
        ...config,
        portApi: {
          host: "0.0.0.0",
          port: 8485,
          token: "port-api-secret",
          advertisedUrl: "http://10.0.0.7:8485",
        },
      },
      backend,
      controlPlane: { ...controlPlane, register },
      wsServer: {
        ...wsServer,
        listen: async () => {
          order.push("listen");
        },
      },
    });

    await copy.start();

    expect(order).toEqual(["register", "listen"]);
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "test runner",
        replicaName: "pod-test",
        portApiUrl: "http://10.0.0.7:8485",
      }),
    );
    await copy.stop();
  });

  it("registers WITHOUT a port-API address when this copy serves none", async () => {
    const register = vi.fn<ControlPlaneClient["register"]>(async () => ({
      runnerId: "r-1",
      replicaId: "copy-1",
    }));
    const copy = createRunner({
      config,
      backend,
      controlPlane: { ...controlPlane, register },
      wsServer,
    });
    await copy.start();
    expect(register.mock.calls[0]?.[0]).not.toHaveProperty("portApiUrl");
    await copy.stop();
  });

  it("stops by retiring, THEN draining its sockets, THEN closing", async () => {
    // Retiring first is what makes the control plane hand this copy nothing
    // new from here on (the Temporal lesson: tell the server the moment the
    // shutdown starts); its supervisors then reconnect to the other copies,
    // whose claims never wait on this one. Closing before draining would
    // cut the sockets without the 1012 that sends them straight to another
    // copy. MUTATION-PROOF: reorder or drop a step.
    const order: string[] = [];
    const copy = createRunner({
      config,
      backend,
      controlPlane: {
        ...controlPlane,
        // Finishes a beat later: `drain` must wait for it, not just follow
        // its call.
        retire: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push("retire");
        },
      },
      wsServer: {
        ...wsServer,
        drain: async () => {
          order.push("drain");
        },
        close: async () => {
          order.push("close");
        },
      },
    });
    await copy.start();
    await copy.stop();
    expect(order).toEqual(["retire", "drain", "close"]);
  });

  it("waits for its in-flight poll before closing, and runs what it brought back", async () => {
    // The poll parked on the server when the copy stops can still return
    // work claimed just before the retire landed. That work is this copy's
    // (the control plane recorded it so): a start still runs, and a turn
    // whose socket is gone by then is given back for another copy, never
    // dropped. MUTATION-PROOF: stop without awaiting the run loop.
    let answerPoll: (items: RunnerWorkItem[]) => void = () => {};
    let pollParked: () => void = () => {};
    const parked = new Promise<void>((resolve) => {
      pollParked = resolve;
    });
    let polls = 0;
    const copy = createRunner({
      config,
      backend,
      controlPlane: {
        ...controlPlane,
        pollWork: async () => {
          polls += 1;
          if (polls > 1) return [];
          pollParked();
          return new Promise<RunnerWorkItem[]>((resolve) => {
            answerPoll = resolve;
          });
        },
      },
      wsServer,
    });
    await copy.start();
    const looping = copy.run();
    await parked;

    let stopped = false;
    const stopping = copy.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);
    expect(retired).toBe(1);

    answerPoll([
      {
        kind: "turn.deliver",
        sandboxId: "sb-gone",
        conversationId: "cv-1",
        turnId: "t-1",
        message: "hi",
      },
    ]);
    await stopping;
    await looping;
    await copy.settle();
    expect(polls).toBe(1);
    expect(posted).toContainEqual(
      expect.objectContaining({
        kind: "turn.finished",
        turnId: "t-1",
        errorCode: TURN_FAILURE_CODES.agentRestarted,
      }),
    );
  });

  it("still closes when retiring fails: the liveness window does the handover", async () => {
    let closed = false;
    const copy = createRunner({
      config,
      backend,
      controlPlane: {
        ...controlPlane,
        retire: async () => {
          throw new ControlPlaneError(503, "down");
        },
      },
      wsServer: {
        ...wsServer,
        close: async () => {
          closed = true;
        },
      },
    });
    await copy.start();
    await expect(copy.stop()).resolves.toBeUndefined();
    expect(closed).toBe(true);
  });

  it("leaves its sandboxes running when it stops (a roll, not a teardown)", async () => {
    await runner.start();
    queued.push(startItem("sb-1"));
    await drive();
    await runner.stop();
    expect(drained).toBe(1);
    expect(retired).toBe(1);
    expect(backend.sandboxes.get("sb-1")?.running).toBe(true);
  });
});

describe("the vanished-pod arm (expected running, no snapshot)", () => {
  // A sandbox deleted out-of-band (a host failure, an
  // eviction, a `docker rm`) leaves NO snapshot, so every snapshot-driven
  // arm above is structurally blind: the control plane keeps reading
  // `running`, a `running` sandbox is never re-started, and only the
  // 30-minute idle-stop eventually unwedges it. The arm reports `stopped`
  // once absence has held for two consecutive passes, and the ordinary wake
  // path recovers.

  /** The container the control plane believes sb-1 has. */
  let believedRef = "";
  const vanishedReport = (): RunnerEvent => ({
    kind: "sandbox.status",
    sandboxId: "sb-1",
    status: "stopped",
    observedContainerRef: believedRef,
  });

  /** Start sb-1, let it settle running, then vanish it out-of-band. */
  const vanish = async (): Promise<void> => {
    queued.push(startItem("sb-1"));
    await drive();
    believedRef = backend.sandboxes.get("sb-1")!.containerRef;
    backend.sandboxes.delete("sb-1");
    expectedSandboxIds = ["sb-1"];
    expectedStatuses = { "sb-1": "running" };
    channelFacts = { "sb-1": facts("dropped", Date.now(), believedRef) };
    posted.length = 0;
  };

  it("reports stopped only after absence holds for two passes, naming the container found missing", async () => {
    // Named, so the report applies whichever copy owns the sandbox (the
    // reconciler often does not), yet never knocks down a container a start
    // put there meanwhile. MUTATION-PROOF: delete the arm and the second
    // expect fails; make it single-pass and the first one does; drop the
    // stamp and the second one does too.
    await vanish();

    await runner.reconcile();
    expect(posted).toEqual([]);

    await runner.reconcile();
    expect(posted).toEqual([vanishedReport()]);
  });

  it("reports unstamped (the owner's word) only when the control plane knows no container for it", async () => {
    await vanish();
    channelFacts = { "sb-1": facts("none", null, null) };
    await runner.reconcile();
    await runner.reconcile();
    expect(posted).toEqual([
      { kind: "sandbox.status", sandboxId: "sb-1", status: "stopped" },
    ]);
  });

  it("a reappearing pod clears the candidacy; a re-vanish starts over", async () => {
    queued.push(startItem("sb-1"));
    await drive();
    const record = backend.sandboxes.get("sb-1");
    if (!record) throw new Error("sb-1 never started");
    believedRef = record.containerRef;
    backend.sandboxes.delete("sb-1");
    expectedSandboxIds = ["sb-1"];
    expectedStatuses = { "sb-1": "running" };
    posted.length = 0;

    await runner.reconcile();
    // The sandbox is back (a transient list blind spot healed), and healthy:
    // its socket is held, so the snapshot arms stay quiet too.
    backend.sandboxes.set("sb-1", record);
    channelFacts = { "sb-1": facts("held", Date.now(), believedRef) };
    await runner.reconcile();
    expect(posted).toEqual([]);

    backend.sandboxes.delete("sb-1");
    await runner.reconcile();
    expect(posted).toEqual([]);
    await runner.reconcile();
    expect(posted).toEqual([vanishedReport()]);
  });

  it("never fires for a sandbox the control plane does not read as running", async () => {
    // `starting`/`stopping` are the 300s stale-claim's business; everything
    // else expects no sandbox at all.
    await vanish();
    const quiet = [
      "unprovisioned",
      "starting",
      "stopping",
      "stopped",
      "failed",
    ];
    for (const status of quiet) {
      expectedStatuses = { "sb-1": status };
      await runner.reconcile();
      await runner.reconcile();
    }
    expect(posted).toEqual([]);
  });

  it("stays inert against an old control plane; an observation gap resets the clock", async () => {
    // MUTATION-PROOF: drop the no-statuses reset and the second expect fails
    // (the pre-gap sighting would count toward "consecutive").
    await vanish();
    expectedStatuses = undefined;
    await runner.reconcile();
    await runner.reconcile();
    expect(posted).toEqual([]);

    expectedStatuses = { "sb-1": "running" };
    await runner.reconcile();
    expectedStatuses = undefined;
    await runner.reconcile();
    expectedStatuses = { "sb-1": "running" };
    await runner.reconcile();
    expect(posted).toEqual([]);

    await runner.reconcile();
    expect(posted).toEqual([vanishedReport()]);
  });

  it("never fires while the sandbox's start is EXECUTING", async () => {
    // A create call legitimately leaves the id absent from snapshots.
    // MUTATION-PROOF: drop the executingStartHash fence and the expect fails.
    const release = backend.holdNext("create");
    queued.push(startItem("sb-1"));
    await runner.tick(0);
    await vi.waitFor(() => expect(backend.homes.has("sb-1")).toBe(true));
    expectedSandboxIds = ["sb-1"];
    expectedStatuses = { "sb-1": "running" };
    posted.length = 0;

    await runner.reconcile();
    await runner.reconcile();
    expect(posted).toEqual([]);

    release();
    await runner.settle();
  });

  it("never fires while a start is QUEUED behind the sandbox's executing stop", async () => {
    // The realistic shape: the sandbox vanishes while a stop is mid-execution
    // and the recovery start is already queued behind it on the chain.
    // MUTATION-PROOF: drop the queuedStarts fence and the expect fails —
    // the executing stop has already drained its queuedStops slot and no
    // start is executing yet, so this fence is the only one standing.
    queued.push(startItem("sb-1"));
    await drive();
    const stopSpy = vi.spyOn(backend, "stopSandbox");
    const release = backend.holdNext("stop");
    queued.push({ kind: "sandbox.stop", sandboxId: "sb-1" });
    await runner.tick(0);
    await vi.waitFor(() => expect(stopSpy).toHaveBeenCalled());
    queued.push(startItem("sb-1"));
    await runner.tick(0);
    backend.sandboxes.delete("sb-1");
    expectedSandboxIds = ["sb-1"];
    expectedStatuses = { "sb-1": "running" };
    posted.length = 0;

    await runner.reconcile();
    await runner.reconcile();
    expect(posted).toEqual([]);

    release();
    await runner.settle();
  });

  it("never fires while a stop is QUEUED for the sandbox", async () => {
    // MUTATION-PROOF: drop the queuedStops fence and the expect fails — the
    // first stop is executing (its slot drained), the second sits queued.
    queued.push(startItem("sb-1"));
    await drive();
    const stopSpy = vi.spyOn(backend, "stopSandbox");
    const release = backend.holdNext("stop");
    queued.push({ kind: "sandbox.stop", sandboxId: "sb-1" });
    await runner.tick(0);
    await vi.waitFor(() => expect(stopSpy).toHaveBeenCalled());
    queued.push({ kind: "sandbox.stop", sandboxId: "sb-1" });
    await runner.tick(0);
    backend.sandboxes.delete("sb-1");
    expectedSandboxIds = ["sb-1"];
    expectedStatuses = { "sb-1": "running" };
    posted.length = 0;

    await runner.reconcile();
    await runner.reconcile();
    expect(posted).toEqual([]);

    release();
    await runner.settle();
  });

  it("releases the vanished sandbox's admitted-capacity slot for its own recovery start", async () => {
    // The capacity prune skips ids with an executing start, so the recovery
    // start for the vanished sandbox itself would otherwise count its own
    // stale admission and refuse itself at_capacity on a full runner.
    // MUTATION-PROOF: drop the arm's admittedNew.delete and this fails.
    runner = createRunner({
      config: { ...config, maxSandboxes: 1 },
      backend,
      controlPlane,
      wsServer,
    });
    await vanish();
    await runner.reconcile();
    await runner.reconcile();
    posted.length = 0;

    queued.push(startItem("sb-1"));
    await drive();

    expect(
      posted.some(
        (event) => event.kind === "sandbox.status" && event.status === "failed",
      ),
    ).toBe(false);
    expect(backend.sandboxes.get("sb-1")?.running).toBe(true);
  });

  it("reconcile passes never overlap — a call during a held pass is a no-op", async () => {
    // `missingWhileRunning` is cross-pass memory: two overlapped passes
    // would let two stale reads of ONE window count as "consecutive".
    // MUTATION-PROOF: drop the in-flight guard and the call count doubles.
    let calls = 0;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    controlPlane.listAssignedSandboxes = async () => {
      calls += 1;
      await gate;
      return { sandboxIds: [] };
    };

    const held = runner.reconcile();
    await runner.reconcile();
    expect(calls).toBe(1);

    release();
    await held;
    await runner.reconcile();
    expect(calls).toBe(2);
  });

  it("re-reports at most once per two passes while the report keeps landing on deaf ears", async () => {
    // A lost events POST leaves the row `running`: the sandbox is re-marked
    // and re-reported one pass later — self-healing, never per-tick spam.
    await vanish();
    await runner.reconcile();
    await runner.reconcile();
    expect(posted).toHaveLength(1);

    await runner.reconcile();
    expect(posted).toHaveLength(1);
    await runner.reconcile();
    expect(posted).toHaveLength(2);
  });
});

describe("registration", () => {
  it("declares the backend's real capabilities", async () => {
    const register = vi.fn(async () => ({
      runnerId: "r-1",
      replicaId: "copy-1",
    }));
    const spy = createRunner({
      config,
      backend,
      controlPlane: { ...controlPlane, register },
      wsServer,
    });

    await spy.start();

    expect(register).toHaveBeenCalledWith({
      name: "test runner",
      replicaName: "pod-test",
      capabilities: {
        maxSandboxes: 2,
        backend: "fake",
        homeDurability: "resident",
        // The steer-dispatch gate: the control plane only hands `turn.message`
        // to runners that said they can parse it (an unknown kind poisons a
        // whole poll batch on an older build).
        steerMessages: true,
        // And for SEND NOW: `turn.send_now` only reaches a
        // runner that can forward it.
        sendNow: true,
        // Same gate for attachment manifests: only an advertising runner is
        // told about files, because only it can pull the bytes.
        attachments: true,
        // And ahead of a mid-run follow-up: only such a runner is handed a
        // follow-up WITH files to steer into a live run.
        steerAttachments: true,
        // And for `desktop.control`: the claim arm hands a controller change
        // only to a runner that forwards it.
        desktopControl: true,
        // And for the reverse direction: the supervisor is offered send_file
        // only when its runner can relay the bytes.
        outboundAttachments: true,
      },
    });
    await spy.stop();
  });

  it("prepares the backend before registering", async () => {
    await runner.start();
    expect(backend.prepared()).toBe(true);
    await runner.stop();
  });

  it("waits out answered-but-transient statuses (a WAF 403, a deploy 5xx), not just transport failures", async () => {
    // Under NAT-IP rate limiting a register-time WAF 403 used to exit the
    // process — a crash loop the very blockage then kept down. Register is
    // idempotent server-side, so transient statuses wait like transport
    // failures do.
    vi.useFakeTimers();
    try {
      const answers = [403, 429, 503];
      const register = vi.fn(async () => {
        const status = answers.shift();
        if (status !== undefined) {
          throw new ControlPlaneError(status, `register failed: ${status}`);
        }
        return { runnerId: "r-1", replicaId: "copy-1" };
      });
      const spy = createRunner({
        config,
        backend,
        controlPlane: { ...controlPlane, register },
        wsServer,
      });
      const starting = spy.start();
      // Backoff: 500ms, then 1s, then 2s.
      await vi.advanceTimersByTimeAsync(500 + 1_000 + 2_000);
      await starting;
      expect(register).toHaveBeenCalledTimes(4);
      await spy.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still exits on a durable refusal (401 = wrong RUNNER_TOKEN)", async () => {
    // Retrying a real refusal would hide a misconfiguration forever.
    const register = vi.fn(async () => {
      throw new ControlPlaneError(401, "register failed: 401");
    });
    const spy = createRunner({
      config,
      backend,
      controlPlane: { ...controlPlane, register },
      wsServer,
    });
    await expect(spy.start()).rejects.toBeInstanceOf(ControlPlaneError);
    expect(register).toHaveBeenCalledTimes(1);
    await spy.stop().catch(() => {});
  });
});

describe("the control channel must not be proxied", () => {
  it("exempts the runner host from the sandbox's proxy env", async () => {
    queued.push(startItem());
    await drive();

    const env = backend.sandboxes.get("sb-1")?.spec.env ?? {};
    // The runner, plus loopback: an agent checking its own service on
    // localhost must not be sent to the gateway.
    expect(env.NO_PROXY).toBe("runner,localhost,127.0.0.1,::1");
    expect(env.no_proxy).toBe("runner,localhost,127.0.0.1,::1");
    // The gateway proxy itself is untouched — all agent egress still goes there.
    expect(env.HTTPS_PROXY).toContain("gateway:10255");
  });

  it("APPENDS to a NO_PROXY the payload already set, never clobbers it", async () => {
    queued.push(
      startItem("sb-1", {
        env: {
          HTTPS_PROXY: "http://x:aoc_token@gateway:10255",
          NO_PROXY: "localhost,127.0.0.1",
        },
      }),
    );
    await drive();

    expect(backend.sandboxes.get("sb-1")?.spec.env.NO_PROXY).toBe(
      "localhost,127.0.0.1,runner,::1",
    );
  });

  it("does not duplicate the host when it is already exempt", async () => {
    queued.push(
      startItem("sb-1", {
        env: { HTTPS_PROXY: "http://x:t@gateway:10255", NO_PROXY: "runner" },
      }),
    );
    await drive();

    expect(backend.sandboxes.get("sb-1")?.spec.env.NO_PROXY).toBe(
      "runner,localhost,127.0.0.1,::1",
    );
  });
});

describe("noProxyForRunner loopback switch", () => {
  it("exempts loopback by default and keeps it proxied when switched off", () => {
    expect(noProxyForRunner("runner", {}).NO_PROXY).toBe(
      "runner,localhost,127.0.0.1,::1",
    );
    expect(noProxyForRunner("runner", {}, false).NO_PROXY).toBe("runner");
  });
});

describe("turn delivery", () => {
  const turnItem = (
    overrides: Partial<Extract<RunnerWorkItem, { kind: "turn.deliver" }>> = {},
  ): RunnerWorkItem => ({
    kind: "turn.deliver",
    sandboxId: "sb-1",
    conversationId: "cv-1",
    turnId: "t-1",
    message: "what is in this repo?",
    ...overrides,
  });

  it("hands the turn straight down the sandbox's control channel", async () => {
    connected.add("sb-1");
    queued.push(turnItem());
    await drive();

    expect(delivered.get("sb-1")).toEqual([
      {
        kind: "turn.deliver",
        turnId: "t-1",
        conversationId: "cv-1",
        message: "what is in this repo?",
      },
    ]);
  });

  it("passes the resume ref through when the conversation has one", async () => {
    connected.add("sb-1");
    queued.push(turnItem({ resumeSessionRef: "sess-abc" }));
    await drive();

    expect(delivered.get("sb-1")?.[0]).toMatchObject({
      resumeSessionRef: "sess-abc",
    });
  });

  it("gives a turn back once when its socket closes while its files are pulled", async () => {
    // With several copies, the supervisor may come back on another copy,
    // which is handed the turn from then on. MUTATION-PROOF: drop the
    // give-back and the turn is lost silently; wait for a reconnect here and
    // the delivery chain never settles.
    const bytes = Buffer.from("file-bytes");
    const entry = {
      id: "att-1",
      path: "attachments/t-1/notes.txt",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    connected.add("sb-1");
    controlPlane.fetchAttachment = async () => {
      connected.delete("sb-1");
      return bytes;
    };
    queued.push(turnItem({ attachments: [entry] }));
    await runner.tick(0);
    await runner.settle();

    expect(delivered.has("sb-1")).toBe(false);
    expect(posted.filter((event) => event.kind === "turn.finished")).toEqual([
      expect.objectContaining({
        turnId: "t-1",
        status: "failed",
        errorCode: TURN_FAILURE_CODES.agentRestarted,
      }),
    ]);
  });

  it("forwards the memory context verbatim — and omits the key when absent", async () => {
    connected.add("sb-1");
    queued.push(turnItem({ context: "[Your memory — index]" }), turnItem());
    await drive();

    const [withContext, without] = delivered.get("sb-1") ?? [];
    expect(withContext).toMatchObject({ context: "[Your memory — index]" });
    expect(without).not.toHaveProperty("context");
  });

  it("reports NOTHING on a successful delivery — progress comes back later", async () => {
    // The turn's outcome arrives over the control channel, asynchronously. An
    // event here would race the real one.
    connected.add("sb-1");
    queued.push(turnItem());
    await drive();

    expect(posted).toEqual([]);
  });

  it("does not wait for the turn — the next work item runs immediately", async () => {
    // A turn can run for minutes and `tick` executes items serially, so an
    // awaited delivery would stall every other sandbox's lifecycle behind it.
    connected.add("sb-1");
    queued.push(turnItem(), startItem("sb-2"));
    await drive();

    expect(backend.sandboxes.get("sb-2")?.running).toBe(true);
  });

  it("GIVES BACK a turn when this copy holds no socket for the sandbox, and says nothing about the sandbox itself", async () => {
    // The control plane routes a turn to the copy holding the socket; one
    // that lands here with none means the socket just moved (or closed).
    // Holding it here would wait on a socket that may be reconnecting to a
    // DIFFERENT copy; a `stopped` would knock down a sandbox another copy is
    // serving. Coded `agent_restarted`, the never-started turn is revived
    // and re-routed to wherever the socket is now.
    // MUTATION-PROOF: report the sandbox stopped again and the length check
    // fails; drop the code and the toMatchObject does.
    queued.push(turnItem());
    await drive();

    expect(posted).toEqual([
      expect.objectContaining({
        kind: "turn.finished",
        sandboxId: "sb-1",
        conversationId: "cv-1",
        turnId: "t-1",
        status: "failed",
        errorCode: "agent_restarted",
      }),
    ]);
    expect(delivered.has("sb-1")).toBe(false);
  });

  it("never waits for a socket: the give-back is immediate, so the chain behind it moves", async () => {
    queued.push(turnItem(), startItem("sb-2"));
    await drive();
    expect(posted.some((e) => e.kind === "turn.finished")).toBe(true);
    expect(backend.sandboxes.get("sb-2")?.running).toBe(true);
  });

  it("forwards an abort to the running sandbox", async () => {
    connected.add("sb-1");
    queued.push({
      kind: "turn.abort",
      sandboxId: "sb-1",
      conversationId: "cv-1",
      turnId: "t-1",
    });
    await drive();

    expect(delivered.get("sb-1")).toEqual([
      { kind: "turn.abort", turnId: "t-1", conversationId: "cv-1" },
    ]);
    expect(posted).toEqual([]);
  });

  it("treats an abort for an unreachable sandbox as already aborted", async () => {
    queued.push({
      kind: "turn.abort",
      sandboxId: "sb-gone",
      conversationId: "cv-1",
      turnId: "t-1",
    });
    await drive();

    expect(posted).toEqual([
      {
        kind: "turn.finished",
        sandboxId: "sb-gone",
        conversationId: "cv-1",
        turnId: "t-1",
        status: "aborted",
      },
    ]);
  });

  it("forwards a steer with its frame verbatim, and omits the key when absent", async () => {
    connected.add("sb-1");
    const steer = {
      kind: "turn.message",
      sandboxId: "sb-1",
      conversationId: "cv-1",
      turnId: "f-1",
      targetTurnId: "t-1",
      message: "also check the linter",
    } as const;
    queued.push({ ...steer, context: "[new message]" }, steer);
    await drive();

    expect(delivered.get("sb-1")).toEqual([
      {
        kind: "turn.message",
        turnId: "f-1",
        targetTurnId: "t-1",
        conversationId: "cv-1",
        message: "also check the linter",
        context: "[new message]",
      },
      {
        kind: "turn.message",
        turnId: "f-1",
        targetTurnId: "t-1",
        conversationId: "cv-1",
        message: "also check the linter",
      },
    ]);
    expect(posted).toEqual([]);
  });

  it("forwards a SEND NOW down the channel, and drops it silently with no channel", async () => {
    connected.add("sb-1");
    const sendNow = {
      kind: "turn.send_now",
      sandboxId: "sb-1",
      conversationId: "cv-1",
      turnId: "f-1",
      targetTurnId: "t-1",
    } as const;
    queued.push(sendNow, { ...sendNow, sandboxId: "sb-gone" });
    await drive();

    expect(delivered.get("sb-1")).toEqual([
      {
        kind: "turn.send_now",
        turnId: "f-1",
        targetTurnId: "t-1",
        conversationId: "cv-1",
      },
    ]);
    // No invented outcome for a sandbox it could not reach: the message is
    // still read at its next safe point, or runs as the next turn.
    expect(delivered.has("sb-gone")).toBe(false);
    expect(posted).toEqual([]);
  });

  it("forwards a desktop control flip down the channel, and drops it silently with no channel", async () => {
    connected.add("sb-1");
    const take = {
      kind: "desktop.control",
      sandboxId: "sb-1",
      controlled: true,
      controllerName: "Alex Kim",
    } as const;
    queued.push(
      take,
      { kind: "desktop.control", sandboxId: "sb-1", controlled: false },
      { ...take, sandboxId: "sb-gone" },
    );
    await drive();

    expect(delivered.get("sb-1")).toEqual([
      { kind: "desktop.control", controlled: true, controllerName: "Alex Kim" },
      { kind: "desktop.control", controlled: false },
    ]);
    // The control plane re-sends the current state on its next change and
    // the supervisor's handler is idempotent: nothing to invent here.
    expect(delivered.has("sb-gone")).toBe(false);
    expect(posted).toEqual([]);
  });

  it("delivers to the right sandbox when several are connected", async () => {
    connected.add("sb-1");
    connected.add("sb-2");
    queued.push(turnItem({ sandboxId: "sb-2", turnId: "t-2" }));
    await drive();

    expect(delivered.has("sb-1")).toBe(false);
    expect(delivered.get("sb-2")?.[0]).toMatchObject({ turnId: "t-2" });
  });

  describe("a mid-run follow-up WITH files", () => {
    const bytes = Buffer.from("png-bytes");
    const entry = {
      id: "att-1",
      path: "attachments/f-1/photo.png",
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const steerWithFile: Extract<RunnerWorkItem, { kind: "turn.message" }> = {
      kind: "turn.message",
      sandboxId: "sb-1",
      conversationId: "cv-1",
      turnId: "f-1",
      targetTurnId: "t-1",
      message: "what is this?",
      context: "[new message]",
      attachments: [entry],
    };
    const kinds = () => (delivered.get("sb-1") ?? []).map((f) => f.kind);

    it("pulls each file and streams it AHEAD of the steer frame, which carries the manifest", async () => {
      connected.add("sb-1");
      controlPlane.fetchAttachment = async () => bytes;
      queued.push(steerWithFile);
      await drive();

      expect(kinds()).toEqual(["attachment.part", "turn.message"]);
      expect(delivered.get("sb-1")?.[0]).toMatchObject({
        kind: "attachment.part",
        turnId: "f-1",
        attachmentId: "att-1",
      });
      expect(delivered.get("sb-1")?.[1]).toEqual({
        kind: "turn.message",
        turnId: "f-1",
        targetTurnId: "t-1",
        conversationId: "cv-1",
        message: "what is this?",
        context: "[new message]",
        attachments: [entry],
      });
      expect(posted).toEqual([]);
    });

    it("a text steer and a Send now sent after it never overtake its file pull", async () => {
      // MUTATION-TESTED: forward a text steer straight to the socket and it
      // reaches the supervisor before the message it was sent after.
      connected.add("sb-1");
      let release!: () => void;
      let pullStarted = false;
      const pulled = new Promise<void>((resolve) => (release = resolve));
      controlPlane.fetchAttachment = async () => {
        pullStarted = true;
        await pulled;
        return bytes;
      };
      queued.push(
        steerWithFile,
        {
          kind: "turn.message",
          sandboxId: "sb-1",
          conversationId: "cv-1",
          turnId: "f-2",
          targetTurnId: "t-1",
          message: "and also this",
        },
        {
          kind: "turn.send_now",
          sandboxId: "sb-1",
          conversationId: "cv-1",
          turnId: "f-1",
          targetTurnId: "t-1",
        },
      );
      await runner.tick(0);
      // The pull is in flight; give everything queued behind it every
      // chance to run, then prove nothing jumped it.
      await vi.waitFor(() => expect(pullStarted).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(kinds()).toEqual([]);
      release();
      await runner.settle();

      expect(
        (delivered.get("sb-1") ?? []).map((f) =>
          "turnId" in f ? `${f.kind}:${f.turnId}` : f.kind,
        ),
      ).toEqual([
        "attachment.part:f-1",
        "turn.message:f-1",
        "turn.message:f-2",
        "turn.send_now:f-1",
      ]);
    });

    it("an abort is NEVER held behind a file pull", async () => {
      connected.add("sb-1");
      // A pull that never finishes: the abort must reach the socket anyway.
      controlPlane.fetchAttachment = () => new Promise<Buffer>(() => {});
      queued.push(steerWithFile, {
        kind: "turn.abort",
        sandboxId: "sb-1",
        conversationId: "cv-1",
        turnId: "t-1",
      });
      await runner.tick(0);

      await vi.waitFor(() => expect(kinds()).toEqual(["turn.abort"]));
    });

    it("is skipped with no live channel (promotion covers it), pulling nothing and reporting nothing", async () => {
      let pulls = 0;
      controlPlane.fetchAttachment = async () => {
        pulls += 1;
        return bytes;
      };
      queued.push(steerWithFile);
      await drive();

      expect(pulls).toBe(0);
      expect(delivered.has("sb-1")).toBe(false);
      expect(posted).toEqual([]);
    });

    it("is skipped at once when the socket closes mid-pull, never held waiting on this copy", async () => {
      // With several copies the supervisor may come back on another one,
      // which is handed the sandbox's work from then on; promotion runs the
      // message as a turn. MUTATION-PROOF: wait for a reconnect here and the
      // pull's chain never settles, holding every later frame behind it.
      connected.add("sb-1");
      controlPlane.fetchAttachment = async () => {
        connected.delete("sb-1");
        return bytes;
      };
      queued.push(steerWithFile);
      await runner.tick(0);
      await runner.settle();

      expect(delivered.has("sb-1")).toBe(false);
      expect(posted).toEqual([]);
    });

    it("is skipped at once when the socket closes after its files land, before the steer frame", async () => {
      // The files went down the old socket; the words have no socket to
      // ride. MUTATION-PROOF: wait for a reconnect before the steer frame
      // and the chain never settles.
      connected.add("sb-1");
      controlPlane.fetchAttachment = async () => bytes;
      const send = wsServer.connection;
      wsServer.connection = (sandboxId) => {
        const live = send(sandboxId);
        if (!live) return undefined;
        return {
          ...live,
          send: (item: WorkItem) => {
            live.send(item);
            if (item.kind === "attachment.part") connected.delete("sb-1");
          },
        };
      };
      queued.push(steerWithFile);
      await runner.tick(0);
      await runner.settle();

      expect(kinds()).toEqual(["attachment.part"]);
      expect(posted).toEqual([]);
    });

    it("a file that fails to pull is skipped; the words still go", async () => {
      connected.add("sb-1");
      controlPlane.fetchAttachment = async () => {
        throw new Error("store blip");
      };
      queued.push(steerWithFile);
      await drive();

      expect(kinds()).toEqual(["turn.message"]);
    });
  });
});

describe("object ownership survives a restart", () => {
  it("adopts the control plane's stable id before touching anything", async () => {
    // A per-process id would make a restarted runner blind to the volumes it
    // created before — they would leak with nothing able to see them.
    const seen: Array<string | undefined> = [];
    const watching = createRunner({
      config,
      backend,
      controlPlane: {
        ...controlPlane,
        listAssignedSandboxes: async () => {
          seen.push(backend.owner());
          return { sandboxIds: [] };
        },
      },
      wsServer,
    });

    await watching.start();

    // The boot reconcile already ran under the registered id.
    expect(seen).toEqual(["r-1"]);
    expect(backend.owner()).toBe("r-1");
    await watching.stop();
  });
});

describe("home sync fan-out", () => {
  const syncItem = (
    overrides: Partial<
      Extract<RunnerWorkItem, { kind: "skills.changed" }>
    > = {},
  ): RunnerWorkItem => ({
    kind: "skills.changed",
    sandboxId: "sb-1",
    generation: 4,
    parts: [
      { files: [{ path: ".agents/skills/deploy/SKILL.md", content: "# one" }] },
      {
        files: [{ path: "memory/index.md", content: "# Memory index" }],
        prune: [".agents/skills/deploy/SKILL.md", "memory/index.md"],
        instructions: "Be brief.",
        agentName: "andy",
        channels: [
          {
            provider: "slack",
            status: "active",
            handle: "andy",
            workspaceName: "Acme",
          },
        ],
        peers: [{ name: "Mark" }],
        connections: [
          {
            provider: "salesforce",
            name: "Salesforce",
            label: "a@example.com",
            host: "acme.my.salesforce.com",
          },
        ],
      },
    ],
    ...overrides,
  });

  it("fans the parts out in order with part/of stamps and returns nothing", async () => {
    connected.add("sb-1");
    queued.push(syncItem());
    await drive();

    const frames = delivered.get("sb-1") ?? [];
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      kind: "skills.changed",
      generation: 4,
      part: 1,
      of: 2,
    });
    expect(frames[0]).not.toHaveProperty("prune");
    expect(frames[1]).toMatchObject({
      kind: "skills.changed",
      part: 2,
      of: 2,
      instructions: "Be brief.",
      agentName: "andy",
      channels: [{ provider: "slack", status: "active", handle: "andy" }],
      // Every final-part render input is relayed — a dropped field reads as
      // "unchanged" at the supervisor and pins the old doc until reboot.
      peers: [{ name: "Mark" }],
      connections: [{ provider: "salesforce", host: "acme.my.salesforce.com" }],
    });
    expect(posted).toEqual([]);
  });

  it("no channel is a strict NO-OP — no frames, ZERO events", async () => {
    // The deliverTurn arm reports corrective events here; the sync arm must
    // not (a healthy-but-reconnecting sandbox would be knocked into a
    // respawn cycle). The mutation that copies deliverTurn's arm dies here.
    queued.push(syncItem());
    await drive();

    expect(delivered.get("sb-1")).toBeUndefined();
    expect(posted).toEqual([]);
  });

  it("a batch executes serially: sync frames land before the turn frame", async () => {
    connected.add("sb-1");
    queued.push(syncItem(), {
      kind: "turn.deliver",
      sandboxId: "sb-1",
      conversationId: "cv-1",
      turnId: "t-1",
      message: "use the skill",
    });
    await drive();

    const kinds = (delivered.get("sb-1") ?? []).map((frame) => frame.kind);
    expect(kinds).toEqual(["skills.changed", "skills.changed", "turn.deliver"]);
  });
});

describe("the lifecycle executor (step 4)", () => {
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it("runs different sandboxes' starts CONCURRENTLY when the semaphore allows", async () => {
    runner = createRunner({
      config: { ...config, lifecycleConcurrency: 2 },
      backend,
      controlPlane,
      wsServer,
    });
    const release = backend.holdNext("create");
    queued.push(startItem("sb-1"));
    await runner.tick(0);
    // sb-1 is stuck inside createSandbox holding one slot; sb-2 must sail
    // past it on the second slot.
    queued.push(startItem("sb-2"));
    await runner.tick(0);
    await vi.waitFor(() =>
      expect(backend.sandboxes.get("sb-2")?.running).toBe(true),
    );
    expect(backend.sandboxes.has("sb-1")).toBe(false);

    release();
    await runner.settle();
    expect(backend.sandboxes.get("sb-1")?.running).toBe(true);
  });

  it("keeps backend work globally serialized at lifecycleConcurrency 1", async () => {
    // The self-host contract: docker operations on one host contend, so the
    // default MUST reproduce the old serial tick for starts.
    const release = backend.holdNext("create");
    queued.push(startItem("sb-1"));
    await runner.tick(0);
    queued.push(startItem("sb-2"));
    await runner.tick(0);
    // Absence has no event to await; a short real wait is the only probe.
    await sleep(50);
    expect(backend.sandboxes.has("sb-2")).toBe(false);

    release();
    await runner.settle();
    expect(backend.sandboxes.get("sb-1")?.running).toBe(true);
    expect(backend.sandboxes.get("sb-2")?.running).toBe(true);
  });

  it("SUPERSEDES a queued start's payload with the re-dispatched twin's", async () => {
    // Dispatch composes from current truth: absorbing the twin would build
    // the container from REVOKED credentials, permanently. The queued slot
    // takes the newest payload and keeps its position.
    const release = backend.holdNext("create");
    queued.push(startItem("sb-1"));
    await runner.tick(0);
    await vi.waitFor(() => expect(backend.homes.has("sb-1")).toBe(true));
    // Executing and stuck at create; these two queue behind it on the chain.
    queued.push(
      startItem("sb-1", {
        env: { HTTPS_PROXY: "http://x:aoc_STALE@gateway:10255" },
      }),
    );
    await runner.tick(0);
    queued.push(
      startItem("sb-1", {
        env: { HTTPS_PROXY: "http://x:aoc_FRESH@gateway:10255" },
      }),
    );
    await runner.tick(0);

    release();
    await runner.settle();
    // One queued execution, built from the FRESHEST payload — the stale twin
    // never touched the backend.
    expect(backend.sandboxes.get("sb-1")?.spec.env.HTTPS_PROXY).toContain(
      "aoc_FRESH",
    );
    expect(backend.sandboxes.get("sb-1")?.containerRef).toBe(
      "fake-container-2",
    );
  });

  it("ABSORBS a hash-identical twin of the start executing right now", async () => {
    const release = backend.holdNext("create");
    queued.push(startItem("sb-1"));
    await runner.tick(0);
    await vi.waitFor(() => expect(backend.homes.has("sb-1")).toBe(true));
    queued.push(startItem("sb-1"));
    await runner.tick(0);

    release();
    await runner.settle();
    // A second execution would have recreated: fake-container-2.
    expect(backend.sandboxes.get("sb-1")?.containerRef).toBe(
      "fake-container-1",
    );
    expect(backend.sandboxes.get("sb-1")?.running).toBe(true);
  });

  it("counts in-flight fresh creates against capacity", async () => {
    // N concurrent slots reading one stale live count would all pass at
    // capacity − 1 — and a booting remote sandbox is invisible to `running`.
    runner = createRunner({
      config: { ...config, lifecycleConcurrency: 2 },
      backend,
      controlPlane,
      wsServer,
    });
    const release = backend.holdNext("create");
    queued.push(startItem("sb-1"));
    await runner.tick(0);
    await vi.waitFor(() => expect(backend.homes.has("sb-1")).toBe(true));
    queued.push(startItem("sb-2"));
    await runner.tick(0);
    await vi.waitFor(() =>
      expect(backend.sandboxes.get("sb-2")?.running).toBe(true),
    );

    // live = 1 (sb-2) + in flight = 1 (sb-1, still creating) = the cap of 2.
    queued.push(startItem("sb-3"));
    await runner.tick(0);
    await vi.waitFor(() =>
      expect(
        posted.some(
          (event) =>
            "reasonCode" in event &&
            event.reasonCode === "at_capacity" &&
            event.sandboxId === "sb-3",
        ),
      ).toBe(true),
    );
    expect(backend.sandboxes.has("sb-3")).toBe(false);

    release();
    await runner.settle();
    expect(backend.sandboxes.get("sb-1")?.running).toBe(true);
  });

  it("heartbeats `starting` from ENQUEUE — queued starts included — and stops at settlement", async () => {
    runner = createRunner({
      config,
      backend,
      controlPlane,
      wsServer,
      startHeartbeatMs: 20,
    });
    const release = backend.holdNext("create");
    queued.push(startItem("sb-1"));
    await runner.tick(0);
    // sb-2 sits QUEUED behind the semaphore — the control plane's 300s
    // stale-claim clock must still see progress, so the heartbeat starts at
    // enqueue, not at execution.
    queued.push(startItem("sb-2"));
    await runner.tick(0);

    const heartbeat = (sandboxId: string) =>
      posted.filter(
        (event) =>
          event.kind === "sandbox.status" &&
          event.status === "starting" &&
          event.sandboxId === sandboxId &&
          !("containerRef" in event) &&
          !("homeRef" in event),
      ).length;
    await vi.waitFor(() => {
      expect(heartbeat("sb-1")).toBeGreaterThan(0);
      expect(heartbeat("sb-2")).toBeGreaterThan(0);
    });

    release();
    await runner.settle();
    // Settled: the intervals are cleared — the count stops moving.
    const after = posted.length;
    await sleep(60);
    expect(posted.length).toBe(after);
    // And no heartbeat landed after its sandbox's settlement events.
    const lastIndex = (predicate: (event: RunnerEvent) => boolean): number => {
      for (let i = posted.length - 1; i >= 0; i -= 1) {
        const event = posted[i];
        if (event && predicate(event)) return i;
      }
      return -1;
    };
    const lastFinal = lastIndex(
      (event) => "containerRef" in event && Boolean(event.containerRef),
    );
    const lastHeartbeat = lastIndex(
      (event) =>
        event.kind === "sandbox.status" &&
        event.status === "starting" &&
        !("homeRef" in event),
    );
    expect(lastHeartbeat).toBeLessThan(lastFinal);
  });
});

describe("post-start boot-crash classification (step 4)", () => {
  /** The runner's default dial-in grace (3 min since the spawn). */
  const BOOT_GRACE_MS = 180_000;
  /**
   * sb-1 spawned and recorded (`awaiting`, since `spawnedAgo` ms) and its
   * container already exited: the boot-script regression shape. Any copy
   * may have spawned it; the reconciler judges it from the record alone.
   */
  const crashed = async (spawnedAgo: number): Promise<string> => {
    queued.push(startItem("sb-1"));
    await drive();
    const ref = backend.sandboxes.get("sb-1")!.containerRef;
    await backend.stopSandbox(ref);
    expectedSandboxIds = ["sb-1"];
    channelFacts = { "sb-1": facts("awaiting", Date.now() - spawnedAgo, ref) };
    posted.length = 0;
    return ref;
  };

  it("classifies a dead, never-connected container as start_failed, stamped with it, and removes the corpse", async () => {
    // MUTATION-PROOF: drop the arm and nothing is reported; drop the stamp
    // and the toEqual fails (an unstamped report is the owner's alone, and
    // the reconciler need not own the sandbox).
    const ref = await crashed(BOOT_GRACE_MS + 1);

    await runner.reconcile();

    expect(posted).toEqual([
      {
        kind: "sandbox.status",
        sandboxId: "sb-1",
        status: "failed",
        error: "sandbox exited before the supervisor connected",
        reasonCode: "start_failed",
        observedContainerRef: ref,
      },
    ]);
    // The corpse is removed: while it exists it still holds the home, so
    // the backend can neither park nor release it.
    expect(backend.sandboxes.has("sb-1")).toBe(false);
  });

  it("does NOT classify before the dial-in grace since the SPAWN elapses", async () => {
    await crashed(BOOT_GRACE_MS - 10_000);

    await runner.reconcile();

    expect(posted).toEqual([]);
    expect(backend.sandboxes.has("sb-1")).toBe(true);
  });

  it("does NOT classify while the start is still executing on this copy (mid-boot fence)", async () => {
    runner = createRunner({
      config,
      backend,
      controlPlane,
      wsServer,
      bootDialInGraceMs: 0,
    });
    const release = backend.holdNext("start");
    queued.push(startItem("sb-1"));
    await runner.tick(0);
    // Created but its startSandbox call is held: dead-looking, never
    // connected, exactly what a healthy slow boot looks like.
    await vi.waitFor(() => expect(backend.sandboxes.has("sb-1")).toBe(true));
    const ref = backend.sandboxes.get("sb-1")!.containerRef;
    channelFacts = { "sb-1": facts("awaiting", Date.now() - 60_000, ref) };
    expectedSandboxIds = ["sb-1"];
    posted.length = 0;

    await runner.reconcile();
    expect(posted).toEqual([]);

    release();
    await runner.settle();
    expect(backend.sandboxes.get("sb-1")?.running).toBe(true);
  });

  it("does NOT classify a Pending-phase snapshot (slow, not dead)", async () => {
    // A remote create can return optimistically at its image-watch budget
    // with the sandbox still Pending. Only a terminal phase (or a substrate
    // with no phase concept) may classify.
    await crashed(BOOT_GRACE_MS + 1);
    const original = backend.listSandboxes.bind(backend);
    backend.listSandboxes = async () =>
      (await original()).map((snapshot) => ({ ...snapshot, phase: "Pending" }));

    await runner.reconcile();

    expect(posted).toEqual([]);
    expect(backend.sandboxes.has("sb-1")).toBe(true);
  });
});

describe("review fixes (step-4 whole-PR review)", () => {
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it("a queued hash-differing twin KEEPS the heartbeat across its predecessor's settlement", async () => {
    // The rotated-creds supersede case: start #1 settles while the twin is
    // queued behind it. Stopping the timer there would leave the twin's whole
    // semaphore wait + wake heartbeat-less — stale at 300s, re-dispatched.
    runner = createRunner({
      config,
      backend,
      controlPlane,
      wsServer,
      startHeartbeatMs: 20,
    });
    const releaseFirst = backend.holdNext("create");
    queued.push(startItem("sb-1"));
    await runner.tick(0);
    await vi.waitFor(() => expect(backend.homes.has("sb-1")).toBe(true));
    // Differing hash → queues behind the executing start.
    queued.push(
      startItem("sb-1", {
        env: { HTTPS_PROXY: "http://x:aoc_ROTATED@gateway:10255" },
      }),
    );
    await runner.tick(0);

    // Arm the SECOND hold synchronously before releasing the first — the
    // twin's create must not slip through unheld.
    releaseFirst();
    const releaseSecond = backend.holdNext("create");

    const heartbeats = () =>
      posted.filter(
        (event) =>
          event.kind === "sandbox.status" &&
          event.status === "starting" &&
          event.sandboxId === "sb-1" &&
          !("containerRef" in event) &&
          !("homeRef" in event),
      ).length;
    // Wait until the twin is executing (its recreate deleted #1's container),
    // then require the count to still be MOVING.
    await vi.waitFor(() => expect(backend.sandboxes.has("sb-1")).toBe(false));
    const during = heartbeats();
    await vi.waitFor(() => expect(heartbeats()).toBeGreaterThan(during));

    releaseSecond();
    await runner.settle();
    expect(backend.sandboxes.get("sb-1")?.spec.env.HTTPS_PROXY).toContain(
      "aoc_ROTATED",
    );
    // Settled: the timer is gone.
    const after = posted.length;
    await sleep(60);
    expect(posted.length).toBe(after);
  });

  it("a deliberate stop releases the sandbox's admitted-capacity slot", async () => {
    // Docker lists stopped containers forever (present, not running) — the
    // in-check prune alone would hold the slot and refuse admissible starts.
    queued.push(startItem("sb-1"));
    await drive();
    queued.push({ kind: "sandbox.stop", sandboxId: "sb-1" });
    await drive();

    queued.push(startItem("sb-2"));
    await drive();
    posted.length = 0;
    queued.push(startItem("sb-3"));
    await drive();

    expect(backend.sandboxes.get("sb-3")?.running).toBe(true);
    expect(
      posted.some(
        (event) => "reasonCode" in event && event.reasonCode === "at_capacity",
      ),
    ).toBe(false);
  });
});
