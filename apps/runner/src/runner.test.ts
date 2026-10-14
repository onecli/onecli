import { beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_RESUME_GRACE_MS } from "@onecli/agent-protocol";
import type {
  RunnerEvent,
  RunnerWorkItem,
  SandboxStartPayload,
  WorkItem,
} from "@onecli/agent-protocol";
import type { RunnerConfig } from "./config";
import { ControlPlaneError } from "./control-plane";
import type { ControlPlaneClient } from "./control-plane";
import { ImageUnavailableError, SandboxCapacityError } from "./backend/types";
import { createFakeBackend, type FakeBackend } from "./backend/fake";
import { createRunner, payloadHash, type Runner } from "./runner";
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
  backend: "fake",
  agentImage: "onecli-agent:test",
  sandboxNetwork: "onecli-sandboxes",
  networkInternal: true,
  wsPort: 8484,
  advertisedHost: "runner",
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
let issuedTokens: string[];
/** sandboxId → what the runner pushed down its control channel. */
let delivered: Map<string, WorkItem[]>;
/** Sandboxes with a live channel; anything else has no connection. */
let connected: Set<string>;
/** sandboxId → when its session-holding channel dropped (the resume grace). */
let sessionDroppedAt: Map<string, number>;
/** Every `containerKnown` the runner told the server about, with the ref the
 * runner had recorded at that moment (what the server would sign over). */
let knownContainers: Array<{ sandboxId: string; ref: string | undefined }>;
let controlPlane: ControlPlaneClient;
let wsServer: RunnerWsServer;
let runner: Runner;

beforeEach(() => {
  backend = createFakeBackend();
  posted = [];
  queued = [];
  expectedSandboxIds = [];
  expectedStatuses = undefined;
  issuedTokens = [];
  delivered = new Map();
  connected = new Set();
  sessionDroppedAt = new Map();
  knownContainers = [];

  controlPlane = {
    register: async () => ({ runnerId: "r-1" }),
    pollWork: async () => queued.splice(0, queued.length),
    postEvents: async (events) => {
      posted.push(...events);
    },
    heartbeat: async () => {},
    listAssignedSandboxes: async () => ({
      sandboxIds: expectedSandboxIds,
      ...(expectedStatuses && { statuses: expectedStatuses }),
    }),
    // Default: everything asked about exists (nothing is an orphan), so the
    // sweep is inert unless a test arms it. orphan-sweep.test.ts overrides.
    checkSandboxIds: async () => [],
    toolCall: async () => ({ ok: true, result: null }),
    memoryWrite: async () => ({ ok: true }),
    uploadAttachment: async () => ({ ok: true, attachmentId: "att-fake" }),
    fetchAttachment: async () => Buffer.alloc(0),
  };

  wsServer = {
    issueToken: (sandboxId) => {
      const token = `boot-${sandboxId}-${issuedTokens.length}`;
      issuedTokens.push(token);
      return token;
    },
    resumable: true,
    revokeToken: () => {},
    awaitingConnection: () => false,
    disconnectedAt: (sandboxId) => sessionDroppedAt.get(sandboxId),
    forgetSession: (sandboxId) => sessionDroppedAt.delete(sandboxId),
    containerKnown: (sandboxId) =>
      knownContainers.push({
        sandboxId,
        ref: runner.containerRefOf(sandboxId),
      }),
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
    listen: async () => {},
    close: async () => {},
    crash: async () => {},
  };

  runner = createRunner({ config, backend, controlPlane, wsServer });
});

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

  it("tells the ws server the container is known the moment it records the ref, so a supervisor that dialled in first is handed its session", async () => {
    // The cloud backend's create returns only once the sandbox runs; its
    // supervisor is often connected by then. Without this call such a
    // supervisor never holds a session. The ref must be in the map AT the
    // call (the server signs over it).
    queued.push(startItem());
    await drive();

    const ref = backend.sandboxes.get("sb-1")?.containerRef;
    expect(knownContainers).toEqual([{ sandboxId: "sb-1", ref }]);
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

  it("gives the sandbox a single-use control-channel token and its runner URL", async () => {
    queued.push(startItem());
    await drive();

    const env = backend.sandboxes.get("sb-1")?.spec.env ?? {};
    expect(env.RUNNER_WS_URL).toBe("ws://runner:8484");
    expect(env.SANDBOX_WS_TOKEN).toBe(issuedTokens[0]);
    expect(env.SANDBOX_ID).toBe("sb-1");
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

describe("a sandbox that is running but unreachable", () => {
  // The control-channel token is single-use and lives in the runner's memory,
  // so a supervisor that lost its channel across a runner restart can never
  // re-authenticate. Left alone, the container runs, the control plane still
  // reads `running`, and every turn fails "not reachable" — forever, because
  // a `running` sandbox is never re-started.

  it("reports it as stopped so the normal wake path can recover it", async () => {
    queued.push(startItem("sb-1"));
    await drive();
    expectedSandboxIds = ["sb-1"];
    posted.length = 0;
    // No live channel and no token outstanding = stranded, not booting.

    await runner.reconcile();

    expect(posted).toEqual([
      { kind: "sandbox.status", sandboxId: "sb-1", status: "stopped" },
    ]);
  });

  it("says NOTHING about a sandbox that is still dialling in", async () => {
    // A freshly-created sandbox holds a token and has not connected yet.
    // Reporting it stopped would fight its own start.
    queued.push(startItem("sb-1"));
    await drive();
    expectedSandboxIds = ["sb-1"];
    posted.length = 0;
    wsServer.awaitingConnection = () => true;

    await runner.reconcile();

    expect(posted).toEqual([]);
  });

  it("says nothing about a sandbox with a live channel", async () => {
    queued.push(startItem("sb-1"));
    await drive();
    expectedSandboxIds = ["sb-1"];
    posted.length = 0;
    connected.add("sb-1");

    await runner.reconcile();

    expect(posted).toEqual([]);
  });

  it("reports a DEAD expected container once — then stays quiet", async () => {
    // The double-death shape: the container died while the runner itself was
    // down (a host reboot), so the channel close was never observed and no
    // report ever fired — the control plane may still read `running` with a
    // turn in flight, which would otherwise wait out the whole ceiling. One
    // `stopped` report is the truth; a sandbox that was parked DELIBERATELY
    // absorbs the same report as a no-op (the control plane's status guard),
    // so the dedupe below exists only to stop per-tick churn.
    // MUTATION-PROOF: delete the dead-but-expected arm and the first expect
    // fails; delete the reportedDead dedupe and the second one does.
    queued.push(startItem("sb-1"));
    await drive();
    const ref = backend.sandboxes.get("sb-1")?.containerRef;
    await backend.stopSandbox(ref!);
    expectedSandboxIds = ["sb-1"];
    posted.length = 0;

    await runner.reconcile();
    expect(posted).toEqual([
      { kind: "sandbox.status", sandboxId: "sb-1", status: "stopped" },
    ]);

    posted.length = 0;
    await runner.reconcile();
    expect(posted).toEqual([]);
  });
});

/**
 * THE ZOMBIE BACKSTOP. A running container with no channel whose row the
 * control plane has already parked (`stopped`/`failed`/`unprovisioned`): the
 * report above is a no-op against that row (the status guard only applies
 * `stopped` over running/stopping), so reporting it every pass does nothing
 * forever. That is the shape a supervisor that gave up but never exited
 * leaves behind. The runner is the only party that sees the container, so
 * it stops it, through the ordinary stop path.
 */
describe("a running container the control plane no longer expects to run", () => {
  /** A started sandbox whose channel is gone, as reconcile will find it. */
  const zombie = async (status: string | undefined): Promise<string> => {
    queued.push(startItem("sb-1"));
    await drive();
    expectedSandboxIds = ["sb-1"];
    expectedStatuses = status === undefined ? undefined : { "sb-1": status };
    posted.length = 0;
    return backend.sandboxes.get("sb-1")!.containerRef;
  };

  it.each(["stopped", "failed"])(
    "is STOPPED (home parked, nothing reported) when its row reads `%s`",
    async (status) => {
      // MUTATION-PROOF: drop the backstop and the container stays running
      // (and the old per-pass report comes back).
      const ref = await zombie(status);
      const stopSpy = vi.spyOn(backend, "stopSandbox");

      await runner.reconcile();
      await runner.settle();

      expect(stopSpy).toHaveBeenCalledWith(ref, "sb-1");
      expect(backend.sandboxes.get("sb-1")?.running).toBe(false);
      expect(backend.parks).toContain("fake-home-sb-1");
      // The row is already where this stop leaves it; a report would only
      // be absorbed by the control plane's status guard.
      expect(posted).toEqual([]);
    },
  );

  it("is stopped ONCE: a pass that finds it still listed does not stop it again", async () => {
    // The stop is ref-bound and idempotent, but a container that lingers in
    // the listing (a slow substrate) must not draw a stop every pass.
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
  });

  it("is tried AGAIN on the next pass when the stop itself failed", async () => {
    // A transient backend error must not leave the stray running for good.
    // MUTATION-PROOF: keep the ref deduped after a failed stop and the second
    // pass does nothing.
    await zombie("stopped");
    const stopSpy = vi.spyOn(backend, "stopSandbox");
    backend.failNext("stop");

    await runner.reconcile();
    await runner.settle();
    expect(backend.sandboxes.get("sb-1")?.running).toBe(true);

    await runner.reconcile();
    await runner.settle();
    expect(stopSpy).toHaveBeenCalledTimes(2);
    expect(backend.sandboxes.get("sb-1")?.running).toBe(false);
  });

  it("is only REPORTED, never stopped, while its row reads `running` (the report is what moves the row)", async () => {
    // MUTATION-PROOF: let `running` into the parked set and this stops a
    // container the control plane still believes is serving.
    await zombie("running");
    const stopSpy = vi.spyOn(backend, "stopSandbox");

    await runner.reconcile();
    await runner.settle();

    expect(stopSpy).not.toHaveBeenCalled();
    expect(posted).toEqual([
      { kind: "sandbox.status", sandboxId: "sb-1", status: "stopped" },
    ]);
  });

  it.each(["starting", "stopping", "unprovisioned"])(
    "is left alone while its row reads `%s` (a claim in flight, or a start that is due, owns it)",
    async (status) => {
      await zombie(status);
      const stopSpy = vi.spyOn(backend, "stopSandbox");

      await runner.reconcile();
      await runner.settle();

      expect(stopSpy).not.toHaveBeenCalled();
    },
  );

  it("is only reported against an OLD control plane that sends no statuses", async () => {
    // MUTATION-PROOF: treat a missing status as parked and this stops it.
    await zombie(undefined);
    const stopSpy = vi.spyOn(backend, "stopSandbox");

    await runner.reconcile();
    await runner.settle();

    expect(stopSpy).not.toHaveBeenCalled();
    expect(posted).toEqual([
      { kind: "sandbox.status", sandboxId: "sb-1", status: "stopped" },
    ]);
  });

  it("is left alone while a start for it is QUEUED (the start recreates it anyway)", async () => {
    // The realistic race: a message arrived, the start is claimed and
    // queued behind an executing stop, and reconcile still reads the old
    // status. MUTATION-PROOF: drop the start fence and a second stop lands.
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
  });

  it("is left alone while a start for it is EXECUTING (the old container is still listed mid-recreate)", async () => {
    // The start has begun (its queue slot is drained) and is recreating;
    // a substrate can still list the old container running with no channel
    // while the row reads the old status. MUTATION-PROOF: drop the
    // executing-start fence and reconcile stops the container being replaced.
    const oldRef = await zombie("stopped");
    const old = backend.sandboxes.get("sb-1")!;
    const release = backend.holdNext("create");
    queued.push(startItem("sb-1"));
    await runner.tick(0);
    // The recreate removed the old record and is held inside create; put the
    // old container back, still running, as a lagging substrate would list it.
    await vi.waitFor(() => expect(backend.sandboxes.has("sb-1")).toBe(false));
    backend.sandboxes.set("sb-1", { ...old, running: true });
    const stopSpy = vi.spyOn(backend, "stopSandbox");

    await runner.reconcile();

    release();
    await runner.settle();
    expect(stopSpy).not.toHaveBeenCalledWith(oldRef, "sb-1");
  });

  it("is left alone while a deliberate stop for it is QUEUED (that stop ends this very container)", async () => {
    // One stop executing (its slot drained, held), a second queued behind
    // it, and reconcile still finds the container running with a parked row.
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
  });
});

/**
 * The resumable channel (runner restart survival). A supervisor that holds a
 * session reconnects by itself; the runner's job is to NOT treat the gap as a
 * death for as long as the supervisor is still inside its retry budget
 * (`SESSION_RESUME_GRACE_MS`), and to hold a turn for it rather than fail it.
 */
describe("a sandbox whose session-holding channel dropped (the resume grace)", () => {
  const turnItem = (): RunnerWorkItem => ({
    kind: "turn.deliver",
    sandboxId: "sb-1",
    conversationId: "cv-1",
    turnId: "t-1",
    message: "hello",
  });

  it("is NOT reported stopped while the drop is inside the grace", async () => {
    queued.push(startItem("sb-1"));
    await drive();
    expectedSandboxIds = ["sb-1"];
    posted.length = 0;
    sessionDroppedAt.set("sb-1", Date.now() - 1_000);

    await runner.reconcile();

    expect(posted).toEqual([]);
  });

  it("IS reported stopped once the drop is older than the grace — the supervisor has given up", async () => {
    queued.push(startItem("sb-1"));
    await drive();
    expectedSandboxIds = ["sb-1"];
    posted.length = 0;
    sessionDroppedAt.set("sb-1", Date.now() - SESSION_RESUME_GRACE_MS - 1);

    await runner.reconcile();

    expect(posted).toEqual([
      { kind: "sandbox.status", sandboxId: "sb-1", status: "stopped" },
    ]);
  });

  it("re-learns the container map at boot from the backend, so a RESTARTED process can stamp and verify", async () => {
    // A container this process never spawned: exactly what a runner finds
    // after a deploy. Without the seed, the first process.state frame is
    // dropped and every session reconnect is refused (unknown container).
    queued.push(startItem("sb-old"));
    await drive();
    expectedSandboxIds = ["sb-old"];
    // Simulate the restart: a fresh runner over the same backend, no memory.
    runner = createRunner({ config, backend, controlPlane, wsServer });
    expect(runner.containerRefOf("sb-old")).toBeUndefined();

    await runner.start();

    expect(runner.containerRefOf("sb-old")).toBe(
      backend.sandboxes.get("sb-old")!.containerRef,
    );
  });

  it("a RESTARTED process grants boot-seeded sandboxes the resume grace from its own boot, so the first reconcile does not report them stopped", async () => {
    // The whole point of the feature. The new process has no memory of the
    // old channel's drop (that state died with the old process), so the
    // grace must be anchored on something it DOES know: its own boot, for
    // every running container it inherited. Without this the very first
    // reconcile reports every inherited sandbox stopped, and the feature
    // only "works" when the supervisor wins the race.
    queued.push(startItem("sb-1"));
    await drive();
    expectedSandboxIds = ["sb-1"];
    runner = createRunner({ config, backend, controlPlane, wsServer });
    posted.length = 0;

    await runner.start();
    await runner.reconcile();

    expect(posted).toEqual([]);
  });

  it("a RESTARTED process reports an inherited sandbox stopped once its boot grace is spent with no channel", async () => {
    queued.push(startItem("sb-1"));
    await drive();
    expectedSandboxIds = ["sb-1"];
    runner = createRunner({
      config,
      backend,
      controlPlane,
      wsServer,
      inheritedResumeGraceMs: 30,
    });
    posted.length = 0;

    await runner.start();
    expect(posted).toEqual([]); // start()'s own pass: inside the grace
    await new Promise((resolve) => setTimeout(resolve, 60));
    await runner.reconcile();

    expect(posted).toEqual([
      { kind: "sandbox.status", sandboxId: "sb-1", status: "stopped" },
    ]);
  });

  describe("the DEFAULT inherited grace (3 min, not the supervisor's whole ~15.5 min budget)", () => {
    // A session-holding supervisor redials within a second of losing its
    // runner and keeps retrying (backoff capped at 15 s), so it reconnects as
    // soon as the new process is reachable, normally well under a minute
    // after boot. One that is still silent minutes later is not coming back,
    // and every turn held for it waits until the grace ends. 3 min leaves a
    // wide margin over a normal reconnect and caps that wait (and the old
    // 15.5 min) at 3 min.
    it("holds an inherited sandbox just under 3 min after boot", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const t0 = Date.parse("2026-10-13T12:00:00Z");
        vi.setSystemTime(t0);
        queued.push(startItem("sb-1"));
        await drive();
        expectedSandboxIds = ["sb-1"];
        runner = createRunner({ config, backend, controlPlane, wsServer });
        await runner.start();
        posted.length = 0;

        vi.setSystemTime(t0 + 3 * 60_000 - 1_000);
        await runner.reconcile();
        expect(posted).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("reports it stopped just past 3 min", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const t0 = Date.parse("2026-10-13T12:00:00Z");
        vi.setSystemTime(t0);
        queued.push(startItem("sb-1"));
        await drive();
        expectedSandboxIds = ["sb-1"];
        runner = createRunner({ config, backend, controlPlane, wsServer });
        await runner.start();
        posted.length = 0;

        vi.setSystemTime(t0 + 3 * 60_000 + 1_000);
        await runner.reconcile();
        expect(posted).toEqual([
          { kind: "sandbox.status", sandboxId: "sb-1", status: "stopped" },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves a channel this process SAW drop on the full budget: that supervisor is mid-retry, not unknown", async () => {
      // The 3 min cap is for inherited containers only. A drop observed by
      // the live process (a network blip, a load balancer resetting the
      // flow) keeps the supervisor's whole retry budget as its grace, as
      // before.
      sessionDroppedAt.set("sb-1", Date.now() - 5 * 60_000);
      queued.push(startItem("sb-1"));
      await drive();
      expectedSandboxIds = ["sb-1"];
      posted.length = 0;
      await runner.reconcile();
      expect(posted).toEqual([]);
    });
  });

  it("WITHOUT a keyring a restarted process reports inherited sandboxes stopped at once — the pre-feature behaviour, kept", async () => {
    // No keyring = no supervisor can ever reconnect, so waiting would only
    // delay the recovery the wake path provides.
    queued.push(startItem("sb-1"));
    await drive();
    expectedSandboxIds = ["sb-1"];
    runner = createRunner({
      config,
      backend,
      controlPlane,
      wsServer: { ...wsServer, resumable: false },
    });
    posted.length = 0;

    // start() runs its own reconcile pass; the explicit one is a second.
    await runner.start();

    expect(posted).toEqual([
      { kind: "sandbox.status", sandboxId: "sb-1", status: "stopped" },
    ]);
  });

  it("a container spawned by a runner WITHOUT sessions gets no grace from a keyed successor: its supervisor holds no session and can never reconnect", async () => {
    // The first deploy of the feature, and every roll where the previous
    // process ran keyless: the inherited supervisor is still retrying the
    // single-use token that died with that process, with nothing else to
    // present. Granting it the grace would hold its next turn for the whole
    // ~15 min budget instead of the ordinary cold wake the old contract
    // gives. The container itself carries the fact (spawned with sessions
    // on, or not), so the successor can tell.
    queued.push(startItem("sb-1"));
    runner = createRunner({
      config,
      backend,
      controlPlane,
      wsServer: { ...wsServer, resumable: false },
    });
    await drive();
    expect(backend.sandboxes.get("sb-1")!.spec.resumable).toBe(false);
    expectedSandboxIds = ["sb-1"];
    runner = createRunner({ config, backend, controlPlane, wsServer });
    posted.length = 0;

    await runner.start();

    expect(posted).toEqual([
      { kind: "sandbox.status", sandboxId: "sb-1", status: "stopped" },
    ]);
  });

  it("a container spawned WITH sessions carries the mark, and a keyed successor inherits its grace", async () => {
    queued.push(startItem("sb-1"));
    await drive();
    expect(backend.sandboxes.get("sb-1")!.spec.resumable).toBe(true);
    expectedSandboxIds = ["sb-1"];
    runner = createRunner({ config, backend, controlPlane, wsServer });
    posted.length = 0;

    await runner.start();
    await runner.reconcile();

    expect(posted).toEqual([]);
  });

  it("a DEAD container is never 'reconnecting': its death is reported at once, grace or no grace", async () => {
    // The grace is for a live supervisor dialling back in. A container that
    // exited has no supervisor; waiting out the grace for it would leave an
    // in-flight turn hanging for the whole budget (found live: the
    // key-dropped scenario's recreate never came).
    queued.push(startItem("sb-1"));
    await drive();
    expectedSandboxIds = ["sb-1"];
    posted.length = 0;
    sessionDroppedAt.set("sb-1", Date.now() - 1_000);
    backend.sandboxes.get("sb-1")!.running = false;

    await runner.reconcile();

    expect(posted).toEqual([
      { kind: "sandbox.status", sandboxId: "sb-1", status: "stopped" },
    ]);
  });

  it("a held turn for a container that DIES during the gap fails at once instead of waiting out the grace", async () => {
    sessionDroppedAt.set("sb-1", Date.now() - 1_000);
    queued.push(startItem("sb-1"));
    await drive();
    expectedSandboxIds = ["sb-1"];
    posted.length = 0;
    queued.push(turnItem());
    await runner.tick(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posted).toEqual([]);

    backend.sandboxes.get("sb-1")!.running = false;
    await runner.reconcile();
    await runner.settle();

    expect(posted[0]).toEqual({
      kind: "sandbox.status",
      sandboxId: "sb-1",
      status: "stopped",
    });
    expect(posted.some((e) => e.kind === "turn.finished")).toBe(true);
  });

  it("the boot anchor yields to the ws server's own drop time once the sandbox has dialled in", async () => {
    // Precedence, pinned: a drop the server SAW outranks the boot anchor.
    // An inherited sandbox that connected and then dropped past the grace
    // is reported stopped even though its boot anchor would still be young.
    queued.push(startItem("sb-1"));
    await drive();
    expectedSandboxIds = ["sb-1"];
    runner = createRunner({
      config,
      backend,
      controlPlane,
      wsServer,
      inheritedResumeGraceMs: 10 * 60_000,
    });
    await runner.start();
    sessionDroppedAt.set("sb-1", Date.now() - SESSION_RESUME_GRACE_MS - 1);
    posted.length = 0;

    await runner.reconcile();

    expect(posted).toEqual([
      { kind: "sandbox.status", sandboxId: "sb-1", status: "stopped" },
    ]);
  });

  it("does NOT seed a container that is not running — a corpse must not verify a session", async () => {
    queued.push(startItem("sb-dead"));
    await drive();
    expectedSandboxIds = ["sb-dead"];
    backend.sandboxes.get("sb-dead")!.running = false;
    runner = createRunner({ config, backend, controlPlane, wsServer });

    await runner.start();

    expect(runner.containerRefOf("sb-dead")).toBeUndefined();
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

  /** Start sb-1, let it settle running, then vanish it out-of-band. */
  const vanish = async (): Promise<void> => {
    queued.push(startItem("sb-1"));
    await drive();
    backend.sandboxes.delete("sb-1");
    expectedSandboxIds = ["sb-1"];
    expectedStatuses = { "sb-1": "running" };
    posted.length = 0;
  };

  it("reports stopped only after absence holds for two passes", async () => {
    // MUTATION-PROOF: delete the arm and the second expect fails; make it
    // single-pass and the first one does.
    await vanish();

    await runner.reconcile();
    expect(posted).toEqual([]);

    await runner.reconcile();
    expect(posted).toEqual([
      { kind: "sandbox.status", sandboxId: "sb-1", status: "stopped" },
    ]);
    // The spawn memory is dropped, so the recovery start is a clean create.
    expect(runner.containerRefOf("sb-1")).toBeUndefined();
  });

  it("a reappearing pod clears the candidacy; a re-vanish starts over", async () => {
    queued.push(startItem("sb-1"));
    await drive();
    const record = backend.sandboxes.get("sb-1");
    if (!record) throw new Error("sb-1 never started");
    backend.sandboxes.delete("sb-1");
    expectedSandboxIds = ["sb-1"];
    expectedStatuses = { "sb-1": "running" };
    posted.length = 0;

    await runner.reconcile();
    // The sandbox is back (a transient list blind spot healed), and healthy —
    // give it a live channel so the snapshot arms stay quiet too.
    backend.sandboxes.set("sb-1", record);
    connected.add("sb-1");
    await runner.reconcile();
    expect(posted).toEqual([]);

    backend.sandboxes.delete("sb-1");
    connected.delete("sb-1");
    await runner.reconcile();
    expect(posted).toEqual([]);
    await runner.reconcile();
    expect(posted).toEqual([
      { kind: "sandbox.status", sandboxId: "sb-1", status: "stopped" },
    ]);
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
    expect(posted).toEqual([
      { kind: "sandbox.status", sandboxId: "sb-1", status: "stopped" },
    ]);
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
    const register = vi.fn(async () => ({ runnerId: "r-1" }));
    const spy = createRunner({
      config,
      backend,
      controlPlane: { ...controlPlane, register },
      wsServer,
    });

    await spy.start();

    expect(register).toHaveBeenCalledWith("test runner", {
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
      // And for the reverse direction: the supervisor is offered send_file
      // only when its runner can relay the bytes.
      outboundAttachments: true,
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
        return { runnerId: "r-1" };
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
    expect(env.NO_PROXY).toBe("runner");
    expect(env.no_proxy).toBe("runner");
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
      "localhost,127.0.0.1,runner",
    );
  });

  it("does not duplicate the host when it is already exempt", async () => {
    queued.push(
      startItem("sb-1", {
        env: { HTTPS_PROXY: "http://x:t@gateway:10255", NO_PROXY: "runner" },
      }),
    );
    await drive();

    expect(backend.sandboxes.get("sb-1")?.spec.env.NO_PROXY).toBe("runner");
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

  it("HOLDS the turn while the sandbox is reconnecting inside the grace, and delivers it when the channel returns", async () => {
    sessionDroppedAt.set("sb-1", Date.now() - 1_000);
    queued.push(turnItem());
    // `tick` enqueues; `settle` would wait out the hold, so the gap is
    // observed in between.
    await runner.tick(0);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Nothing failed, nothing reported: the turn waits on the chain.
    expect(posted).toEqual([]);
    expect(delivered.has("sb-1")).toBe(false);

    connected.add("sb-1");
    sessionDroppedAt.delete("sb-1");
    await runner.settle();

    expect(delivered.get("sb-1")?.[0]).toMatchObject({
      kind: "turn.deliver",
      turnId: "t-1",
    });
    expect(posted).toEqual([]);
  });

  it("FAILS a held turn when the grace runs out before the channel returns", async () => {
    sessionDroppedAt.set("sb-1", Date.now() - SESSION_RESUME_GRACE_MS + 300);
    queued.push(turnItem());
    await runner.tick(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posted).toEqual([]);

    // The grace expires with the channel still down: settle drains the
    // held delivery into its failure. `stopped` FIRST (see channelLoss).
    await runner.settle();

    expect(posted[0]).toEqual({
      kind: "sandbox.status",
      sandboxId: "sb-1",
      status: "stopped",
    });
    expect(posted[1]).toMatchObject({
      kind: "turn.finished",
      turnId: "t-1",
      status: "failed",
      errorCode: "agent_restarted",
    });
  });

  it("a RE-DISPATCH of a turn already held is absorbed: one delivery when the channel returns, never two", async () => {
    // While a turn is held the control plane still reads the sandbox as
    // `running` (by design: the runner withholds `stopped` for the grace),
    // so its stale-dispatch window re-hands the SAME turn to this runner
    // every 90 s, and copies queue up behind one hold. Each copy must be
    // recognised as the turn already in hand: a live supervisor runs a
    // turn.deliver it receives, twice if sent twice.
    sessionDroppedAt.set("sb-1", Date.now() - 1_000);
    queued.push(turnItem());
    await runner.tick(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    queued.push(turnItem()); // the 90 s re-claim
    await runner.tick(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posted).toEqual([]);

    connected.add("sb-1");
    sessionDroppedAt.delete("sb-1");
    await runner.settle();

    expect(
      delivered.get("sb-1")?.filter((f) => f.kind === "turn.deliver"),
    ).toHaveLength(1);
    expect(posted).toEqual([]);
  });

  it("a RE-DISPATCH of a held turn that never comes back fails it ONCE: one channel-loss batch, not one per copy", async () => {
    sessionDroppedAt.set("sb-1", Date.now() - SESSION_RESUME_GRACE_MS + 300);
    queued.push(turnItem());
    await runner.tick(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    queued.push(turnItem());
    await runner.tick(0);
    await runner.settle();

    expect(posted.filter((e) => e.kind === "turn.finished")).toHaveLength(1);
    expect(posted.filter((e) => e.kind === "sandbox.status")).toHaveLength(1);
  });

  it("the hold is per TURN: a different turn for the same reconnecting sandbox is held too, and the id is released once the hold resolves", async () => {
    sessionDroppedAt.set("sb-1", Date.now() - 1_000);
    queued.push(turnItem(), turnItem({ turnId: "t-2" }));
    await runner.tick(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    connected.add("sb-1");
    sessionDroppedAt.delete("sb-1");
    await runner.settle();
    expect(
      delivered.get("sb-1")?.map((f) => (f as { turnId?: string }).turnId),
    ).toEqual(["t-1", "t-2"]);

    // Released: the same turn id delivered again later (a genuine new
    // dispatch, the stale window after a real loss) is not absorbed.
    queued.push(turnItem());
    await drive();
    expect(
      delivered.get("sb-1")?.filter((f) => f.kind === "turn.deliver"),
    ).toHaveLength(3);
  });

  it("FAILS the turn when the sandbox has no live channel", async () => {
    // Silence would leave it dispatched until the control plane's stale sweep;
    // the user would watch a spinner for fifteen minutes.
    queued.push(turnItem());
    await drive();

    // The sandbox is corrected to `stopped` FIRST, in the same batch: the
    // control plane's strand door then revives the never-started turn and
    // wakes a fresh boot; the turn report that follows finds it `queued`
    // and is inert. The other order lets this process's own poll re-claim
    // the revived turn against a box that still reads `running`, and the
    // `stopped` then strands it (see channelLoss).
    expect(posted[0]).toEqual({
      kind: "sandbox.status",
      sandboxId: "sb-1",
      status: "stopped",
    });
    expect(posted[1]).toMatchObject({
      kind: "turn.finished",
      sandboxId: "sb-1",
      turnId: "t-1",
      status: "failed",
      // Coded so a NEW control plane can revive a never-started turn
      // invisibly (and write canonical copy otherwise); the raw prose stays
      // for old ones.
      errorCode: "agent_restarted",
    });
    expect(posted).toHaveLength(2);
    expect(delivered.has("sb-1")).toBe(false);
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

  it("delivers to the right sandbox when several are connected", async () => {
    connected.add("sb-1");
    connected.add("sb-2");
    queued.push(turnItem({ sandboxId: "sb-2", turnId: "t-2" }));
    await drive();

    expect(delivered.has("sb-1")).toBe(false);
    expect(delivered.get("sb-2")?.[0]).toMatchObject({ turnId: "t-2" });
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
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it("classifies a dead, never-connected container as start_failed and removes the corpse", async () => {
    runner = createRunner({
      config,
      backend,
      controlPlane,
      wsServer,
      bootDialInGraceMs: 0,
    });
    queued.push(startItem("sb-1"));
    await drive();
    const ref = backend.sandboxes.get("sb-1")?.containerRef;
    // The supervisor never dialled in (its token is still pending) and the
    // container exited — the boot-script regression shape.
    wsServer.awaitingConnection = () => true;
    await backend.stopSandbox(ref!);
    expectedSandboxIds = ["sb-1"];
    posted.length = 0;
    await sleep(5);

    await runner.reconcile();

    expect(posted).toEqual([
      {
        kind: "sandbox.status",
        sandboxId: "sb-1",
        status: "failed",
        error: "sandbox exited before the supervisor connected",
        reasonCode: "start_failed",
      },
    ]);
    // The corpse is removed: while it exists it still holds the home, so
    // the backend can neither park nor release it.
    expect(backend.sandboxes.has("sb-1")).toBe(false);
    expect(runner.containerRefOf("sb-1")).toBeUndefined();
  });

  it("does NOT classify while the start is still executing (mid-boot fence)", async () => {
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
    // connected — exactly what a healthy slow boot looks like.
    await vi.waitFor(() => expect(backend.sandboxes.has("sb-1")).toBe(true));
    wsServer.awaitingConnection = () => true;
    expectedSandboxIds = ["sb-1"];
    posted.length = 0;

    await runner.reconcile();
    expect(posted).toEqual([]);

    release();
    await runner.settle();
    expect(backend.sandboxes.get("sb-1")?.running).toBe(true);
  });

  it("does NOT classify before the dial-in grace elapses", async () => {
    // Default grace (minutes) — a just-settled start whose supervisor has
    // not connected yet must be left alone.
    queued.push(startItem("sb-1"));
    await drive();
    const ref = backend.sandboxes.get("sb-1")?.containerRef;
    wsServer.awaitingConnection = () => true;
    await backend.stopSandbox(ref!);
    expectedSandboxIds = ["sb-1"];
    posted.length = 0;

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

  it("does NOT classify a Pending-phase snapshot as a boot crash", async () => {
    // A remote create can return optimistically at its image-watch budget
    // with the sandbox still Pending — slow, not dead. Only a terminal phase
    // (or a substrate with no phase concept) may classify.
    runner = createRunner({
      config,
      backend,
      controlPlane,
      wsServer,
      bootDialInGraceMs: 0,
    });
    queued.push(startItem("sb-1"));
    await drive();
    const ref = backend.sandboxes.get("sb-1")?.containerRef;
    wsServer.awaitingConnection = () => true;
    await backend.stopSandbox(ref!);
    const original = backend.listSandboxes.bind(backend);
    backend.listSandboxes = async () =>
      (await original()).map((snapshot) => ({
        ...snapshot,
        phase: "Pending",
      }));
    expectedSandboxIds = ["sb-1"];
    posted.length = 0;
    await sleep(5);

    await runner.reconcile();

    expect(posted).toEqual([]);
    expect(backend.sandboxes.has("sb-1")).toBe(true);
  });
});
