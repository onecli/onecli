import { beforeEach, describe, expect, it } from "vitest";
import type { WorkItem } from "@onecli/agent-protocol";
import { createRunner, type Runner } from "./runner";
import { createFakeBackend, type FakeBackend } from "./backend/fake";
import { installationFingerprint } from "./installation";
import type { ControlPlaneClient } from "./control-plane";
import type { RunnerConfig } from "./config";
import type { ManagedObject } from "./backend/types";
import type { RunnerWsServer } from "./ws/server";

/**
 * The stale-label orphan sweep (step 13): objects labeled by a runner id
 * that no longer exists — a control-plane reset, a rotated token — are
 * invisible to the owned reconcile loops forever. The sweep's laws, each
 * pinned here and each mutation-sensitive (delete the guard in runner.ts and
 * the matching test fails):
 *
 *  - authority first: the control plane confirms the sandbox id exists
 *    NOWHERE before anything is destroyed, and a check failure aborts the
 *    sweep with zero destruction;
 *  - grace: younger objects are never reaped, and never even asked about;
 *  - my own label is never the sweep's business;
 *  - unidentifiable/unageable objects are logged, not deleted;
 *  - the kill-switch detects and logs without deleting.
 */

const HOUR_MS = 3_600_000;

const baseConfig: RunnerConfig = {
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
  cloudParkWaitSeconds: 120,
  cloudWakeWaitSeconds: 900,
  cloudImageWaitSeconds: 240,
  lifecycleConcurrency: 1,
};

const MY_RUNNER_ID = "r-1";
const DEAD_RUNNER_ID = "r-dead";
/** This installation's fingerprint — a dead-runner-id orphan of the SAME
 * install carries it; a co-located install's objects carry a different one. */
const MY_INSTALLATION = installationFingerprint(baseConfig.token);

const foreign = (overrides: Partial<ManagedObject> = {}): ManagedObject => ({
  kind: "sandbox",
  ref: `corpse-${overrides.sandboxId ?? "x"}-${overrides.kind ?? "sandbox"}`,
  sandboxId: "sb-gone",
  runnerId: DEAD_RUNNER_ID,
  // Same install, dead runner id — the canonical orphan the sweep targets.
  installationId: MY_INSTALLATION,
  createdAt: new Date(Date.now() - 2 * HOUR_MS),
  ...overrides,
});

let backend: FakeBackend;
let checkCalls: string[][];
let missingIds: string[];
let checkError: Error | undefined;
let controlPlane: ControlPlaneClient;
let wsServer: RunnerWsServer;

const makeRunner = (config: RunnerConfig = baseConfig): Runner =>
  createRunner({ config, backend, controlPlane, wsServer });

beforeEach(() => {
  backend = createFakeBackend();
  checkCalls = [];
  missingIds = [];
  checkError = undefined;

  controlPlane = {
    register: async () => ({ runnerId: MY_RUNNER_ID }),
    pollWork: async () => [],
    postEvents: async () => {},
    heartbeat: async () => {},
    listAssignedSandboxes: async () => ({ sandboxIds: [] }),
    checkSandboxIds: async (sandboxIds) => {
      if (checkError) throw checkError;
      checkCalls.push(sandboxIds);
      return sandboxIds.filter((id) => missingIds.includes(id));
    },
    toolCall: async () => ({ ok: true, result: null }),
    memoryWrite: async () => ({ ok: true }),
    fetchAttachment: async () => Buffer.alloc(0),
  };

  wsServer = {
    issueToken: () => "boot-token",
    revokeToken: () => {},
    awaitingConnection: () => false,
    connection: ():
      | { sandboxId: string; send(item: WorkItem): void }
      | undefined => undefined,
    listen: async () => {},
    close: async () => {},
  };
});

const managedRefs = async (): Promise<string[]> =>
  (await backend.listManaged()).map((object) => object.ref);

describe("the stale-label orphan sweep", () => {
  it("reaps a foreign container AND its volume once the control plane says the sandbox is gone", async () => {
    backend.seedManaged(foreign({ kind: "sandbox", ref: "corpse-container" }));
    backend.seedManaged(foreign({ kind: "home", ref: "corpse-volume" }));
    missingIds = ["sb-gone"];

    const runner = makeRunner();
    await runner.start();

    const refs = await managedRefs();
    expect(refs).not.toContain("corpse-container");
    expect(refs).not.toContain("corpse-volume");
    // One unique id, asked about exactly once.
    expect(checkCalls).toEqual([["sb-gone"]]);
    await runner.stop();
  });

  it("spares objects younger than the grace window — and never asks about them", async () => {
    backend.seedManaged(
      foreign({
        ref: "young-corpse",
        createdAt: new Date(Date.now() - 600_000),
      }),
    );
    missingIds = ["sb-gone"];

    const runner = makeRunner();
    await runner.start();

    expect(await managedRefs()).toContain("young-corpse");
    expect(checkCalls).toEqual([]);
    await runner.stop();
  });

  it("spares foreign objects whose sandbox still exists in the control plane", async () => {
    backend.seedManaged(
      foreign({ ref: "living-elsewhere", sandboxId: "sb-alive" }),
    );
    missingIds = []; // the check answers "nothing is missing"

    const runner = makeRunner();
    await runner.start();

    expect(await managedRefs()).toContain("living-elsewhere");
    expect(checkCalls).toEqual([["sb-alive"]]);
    await runner.stop();
  });

  it("NEVER touches a co-located install's objects, even long-dead and missing", async () => {
    // The shared-daemon case: another OneCLI install's LIVE container +
    // volume, foreign runner id, old, and (in this runner's control plane)
    // "missing" — every other fence passes. The installation fingerprint is
    // the one thing that differs, and it must be enough on its own.
    backend.seedManaged(
      foreign({
        ref: "other-install-container",
        installationId: installationFingerprint(
          "rnr_a-totally-different-install",
        ),
      }),
    );
    backend.seedManaged(
      foreign({
        kind: "home",
        ref: "other-install-volume",
        installationId: installationFingerprint(
          "rnr_a-totally-different-install",
        ),
      }),
    );
    missingIds = ["sb-gone"];

    const runner = makeRunner();
    await runner.start();

    const refs = await managedRefs();
    expect(refs).toContain("other-install-container");
    expect(refs).toContain("other-install-volume");
    // Never even asked the control plane about a foreign install's ids.
    expect(checkCalls).toEqual([]);
    await runner.stop();
  });

  it("spares a pre-fix object with no installation label (treated as foreign)", async () => {
    backend.seedManaged(foreign({ ref: "legacy", installationId: null }));
    missingIds = ["sb-gone"];

    const runner = makeRunner();
    await runner.start();

    expect(await managedRefs()).toContain("legacy");
    expect(checkCalls).toEqual([]);
    await runner.stop();
  });

  it("never touches objects carrying MY runner id — the owned loops' job", async () => {
    backend.seedManaged(
      foreign({ ref: "mine-but-weird", runnerId: MY_RUNNER_ID }),
    );
    missingIds = ["sb-gone"];

    const runner = makeRunner();
    await runner.start();

    expect(await managedRefs()).toContain("mine-but-weird");
    expect(checkCalls).toEqual([]);
    await runner.stop();
  });

  it("spares unidentifiable and unageable objects", async () => {
    backend.seedManaged(foreign({ ref: "no-identity", sandboxId: null }));
    backend.seedManaged(
      foreign({ ref: "no-birthday", sandboxId: "sb-gone", createdAt: null }),
    );
    missingIds = ["sb-gone"];

    const runner = makeRunner();
    await runner.start();

    const refs = await managedRefs();
    expect(refs).toContain("no-identity");
    expect(refs).toContain("no-birthday");
    expect(checkCalls).toEqual([]);
    await runner.stop();
  });

  it("a check failure aborts the sweep with ZERO destruction (and start survives)", async () => {
    backend.seedManaged(foreign({ ref: "corpse-container" }));
    checkError = new Error("older control plane: 404");

    const runner = makeRunner();
    await runner.start(); // must not throw — boot reconcile runs the sweep

    expect(await managedRefs()).toContain("corpse-container");
    await runner.stop();
  });

  it("the kill-switch detects without deleting", async () => {
    backend.seedManaged(foreign({ ref: "corpse-container" }));
    missingIds = ["sb-gone"];

    const runner = makeRunner({ ...baseConfig, orphanReap: false });
    await runner.start();

    // Asked (detection ran), spared (destruction disabled).
    expect(checkCalls).toEqual([["sb-gone"]]);
    expect(await managedRefs()).toContain("corpse-container");
    await runner.stop();
  });

  it("does not run at all before registration identifies this runner", async () => {
    backend.seedManaged(foreign({ ref: "corpse-container" }));
    missingIds = ["sb-gone"];

    const runner = makeRunner();
    await runner.reconcile(); // bare reconcile, no start(): nothing attributable

    expect(await managedRefs()).toContain("corpse-container");
    expect(checkCalls).toEqual([]);
  });

  it("chunks the authority check at the wire bound", async () => {
    for (let i = 0; i < 501; i += 1) {
      backend.seedManaged(
        foreign({ kind: "home", ref: `corpse-${i}`, sandboxId: `sb-${i}` }),
      );
    }
    missingIds = Array.from({ length: 501 }, (_, i) => `sb-${i}`);

    const runner = makeRunner();
    await runner.start();

    expect(checkCalls.map((call) => call.length)).toEqual([500, 1]);
    const refs = await managedRefs();
    expect(refs.filter((ref) => ref.startsWith("corpse-"))).toEqual([]);
    await runner.stop();
  });
});
