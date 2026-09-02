import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ImageUnavailableError,
  SandboxCapacityError,
  type SandboxSpec,
} from "../types";
import { createCloudBackend } from "./cloud-backend";
import { ManagerApiError } from "./manager-client";
import { startFakeManager, type FakeManager } from "./manager-fake";

/**
 * Conformance of the cloud backend against the manager's HTTP contract —
 * through the REAL manager-client over a real socket (the fake is a
 * hand-rolled node:http server, never an import of the cloud-only
 * apps/sandbox-manager). Mirrors docker-backend.test.ts's role for the seam.
 */

let manager: FakeManager;

beforeEach(async () => {
  manager = await startFakeManager();
});
afterEach(async () => {
  await manager.close();
});

const backendFor = (
  overrides: Partial<Parameters<typeof createCloudBackend>[0]> = {},
) =>
  createCloudBackend({
    runnerId: "boot-placeholder",
    installationId: "aabbccdd",
    managerUrl: manager.url,
    managerToken: "shared-secret",
    parkWaitSeconds: 1,
    wakeWaitSeconds: 1,
    imageWaitSeconds: 1,
    pollIntervalMs: 5,
    ...overrides,
  });

const spec = (overrides: Partial<SandboxSpec> = {}): SandboxSpec => ({
  sandboxId: "sbx1",
  workspaceId: "ws1",
  image: "onecli-agent:test",
  env: { HTTPS_PROXY: "http://x:token@gateway:10255" },
  files: [{ containerPath: "/tmp/ca.pem", content: "CERT", mode: 0o600 }],
  homeRef: "home-sbx1",
  limits: { memoryMb: 2048, cpus: 1, pids: 512 },
  payloadHash: "a".repeat(64),
  ...overrides,
});

describe("identity and auth", () => {
  it("presents the shared secret as a Bearer on every call and scopes by the ADOPTED runner id", async () => {
    const backend = backendFor();
    backend.identify("rnr-stable");
    await backend.listSandboxes();
    await backend.listHomes();

    for (const request of manager.requests) {
      expect(request.authorization).toBe("Bearer shared-secret");
    }
    expect(manager.requests[0]?.path).toBe("/v1/sandboxes?runnerId=rnr-stable");
    expect(manager.requests[1]?.path).toBe("/v1/homes?runnerId=rnr-stable");
  });
});

describe("createSandbox", () => {
  it("refuses a spec with no workspaceId before any HTTP happens", async () => {
    const backend = backendFor();
    await expect(
      backend.createSandbox(spec({ workspaceId: undefined })),
    ).rejects.toThrow(/workspaceId/);
    expect(manager.requests).toHaveLength(0);
  });

  it("posts the full create body — ids, files with modes, limits, payload hash", async () => {
    const backend = backendFor();
    backend.identify("rnr1");
    const ref = await backend.createSandbox(spec());
    expect(ref).toBe("pod-uid-1");

    const create = manager.requests.find(
      (request) =>
        request.method === "POST" && request.path === "/v1/sandboxes",
    );
    expect(create?.body).toMatchObject({
      sandboxId: "sbx1",
      workspaceId: "ws1",
      runnerId: "rnr1",
      installationId: "aabbccdd",
      image: "onecli-agent:test",
      files: [{ containerPath: "/tmp/ca.pem", content: "CERT", mode: 0o600 }],
      homeRef: "home-sbx1",
      limits: { memoryMb: 2048, cpus: 1, pids: 512 },
      payloadHash: "a".repeat(64),
    });
  });

  it.each(["ErrImagePull", "ImagePullBackOff", "InvalidImageName"])(
    "classifies waiting reason %s as ImageUnavailableError and removes the doomed spawn",
    async (reason) => {
      manager.createRunning = false;
      const backend = backendFor();
      backend.identify("rnr1");

      const pending = backend.createSandbox(spec());
      // The pod goes into an image-pull refusal after creation. Wait until
      // the create actually landed before arming the reason — a fixed sleep
      // loses to a slow POST on a loaded box, arms an empty map, and the
      // watch then legitimately returns the ref at budget. The settled
      // escape keeps a rejected create from turning into an opaque test
      // timeout: the loop exits and the real error surfaces below.
      let settled = false;
      const armed = pending
        .catch((error: unknown) => error)
        .finally(() => (settled = true));
      while (manager.sandboxes.size === 0 && !settled) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      for (const snapshot of manager.sandboxes.values()) {
        snapshot.waitingReason = reason;
      }
      const error = await armed;

      expect(error).toBeInstanceOf(ImageUnavailableError);
      // The spawn was cleaned up — the next dispatch recreates from the home.
      expect(
        manager.requests.some(
          (request) =>
            request.method === "DELETE" &&
            request.path.startsWith("/v1/sandboxes/pod-uid-"),
        ),
      ).toBe(true);
    },
  );

  it("does NOT classify an ordinary startup wait — returns the ref at budget", async () => {
    manager.createRunning = false;
    const backend = backendFor({ imageWaitSeconds: 0 });
    backend.identify("rnr1");
    const ref = await backend.createSandbox(spec());
    expect(ref).toBe("pod-uid-1");
    expect(manager.sandboxes.has("pod-uid-1")).toBe(true);
  });

  it("FAILS CLOSED against a skewed 2xx create body — never an undefined ref", async () => {
    // A version-skewed manager (or an intermediary) answering 2xx JSON of
    // another shape must be the honest typed refusal, not `undefined`
    // flowing into refs until `/v1/sandboxes/undefined/start` dies later.
    manager.nextCreateBody = { ok: true };
    const backend = backendFor();
    backend.identify("rnr1");
    await expect(backend.createSandbox(spec())).rejects.toMatchObject({
      name: "ManagerApiError",
      code: "unexpected_status",
    });
  });

  it("surfaces the manager's 409 fence refusal as a typed error", async () => {
    manager.nextCreateError = {
      status: 409,
      code: "sandbox_exists",
      message: "still has 1 live pod(s)",
    };
    const backend = backendFor();
    backend.identify("rnr1");
    await expect(backend.createSandbox(spec())).rejects.toMatchObject({
      name: "ManagerApiError",
      status: 409,
      code: "sandbox_exists",
    });
  });

  it("maps the manager's 422 workspace_quota_exceeded to the seam's typed capacity error — the runner then reports at_capacity, the honest copy (step 6)", async () => {
    manager.nextCreateError = {
      status: 422,
      code: "workspace_quota_exceeded",
      message: "Workspace ws-ws1 is at its home quota",
    };
    const backend = backendFor();
    backend.identify("rnr1");
    await expect(backend.createSandbox(spec())).rejects.toBeInstanceOf(
      SandboxCapacityError,
    );
  });

  it("maps the WAKE door's quota refusal the same way — a parked home's PVC recreation can hit the fence too", async () => {
    manager.nextHomeError = {
      status: 422,
      code: "workspace_quota_exceeded",
      message: "Workspace ws-ws1 is at its home quota",
    };
    const backend = backendFor();
    await expect(backend.wakeHome("home-sbx1")).rejects.toBeInstanceOf(
      SandboxCapacityError,
    );
  });
});

describe("lifecycle mapping", () => {
  it("start of an unknown ref is a real error; stop and remove tolerate stale refs", async () => {
    const backend = backendFor();
    await expect(backend.startSandbox("gone")).rejects.toBeInstanceOf(
      ManagerApiError,
    );
    await expect(backend.stopSandbox("gone")).resolves.toBeUndefined();
    await expect(backend.removeSandbox("gone")).resolves.toBeUndefined();
  });

  it("stop/remove carry the sandboxId hint as a query param when the caller has it", async () => {
    // The hint lets the manager resolve the pod with a label-scoped list
    // instead of a fleet-wide scan (step 4). Optional and additive: the
    // ref-only form above must keep working against any manager.
    const backend = backendFor();
    await backend.stopSandbox("pod-1", "sbx1");
    await backend.removeSandbox("pod-1", "sbx1");

    const paths = manager.requests.map((request) => request.path);
    expect(paths).toContain("/v1/sandboxes/pod-1/stop?sandboxId=sbx1");
    expect(paths).toContain("/v1/sandboxes/pod-1?sandboxId=sbx1");
  });

  it("snapshots carry exactly the seam's fields", async () => {
    const backend = backendFor();
    backend.identify("rnr1");
    await backend.createSandbox(spec());
    const snapshots = await backend.listSandboxes();
    expect(snapshots).toEqual([
      {
        sandboxId: "sbx1",
        containerRef: "pod-uid-1",
        running: true,
        payloadHash: "a".repeat(64),
        // The pod phase rides along so the boot-crash classifier can tell a
        // terminal container from one still Pending behind an image pull.
        phase: "Running",
      },
    ]);
  });

  it("same-home recreation: the ref is deterministic across provisions", async () => {
    const backend = backendFor();
    expect(await backend.provisionHome("sbx1")).toBe("home-sbx1");
    expect(await backend.provisionHome("sbx1")).toBe("home-sbx1");
  });

  it("listManaged parses timestamps and preserves nulls", async () => {
    manager.managed.push(
      {
        kind: "home",
        ref: "home-sbx9",
        sandboxId: "sbx9",
        runnerId: "rnr9",
        installationId: null,
        createdAt: "2026-08-18T00:00:00.000Z",
      },
      {
        kind: "sandbox",
        ref: "pod-uid-9",
        sandboxId: null,
        runnerId: null,
        installationId: null,
        createdAt: null,
      },
    );
    const backend = backendFor();
    const managed = await backend.listManaged();
    expect(managed[0]?.createdAt).toEqual(new Date("2026-08-18T00:00:00.000Z"));
    expect(managed[1]).toMatchObject({
      sandboxId: null,
      runnerId: null,
      createdAt: null,
    });
  });
});

describe("park and wake polling", () => {
  it("park returns once ACCEPTED (pending → parking), never awaiting parked", async () => {
    manager.parkStatuses.splice(
      0,
      manager.parkStatuses.length,
      "pending",
      "parking",
    );
    const backend = backendFor();
    await backend.parkHome("home-sbx1");
    const parkCalls = manager.requests.filter((request) =>
      request.path.endsWith("/park"),
    );
    expect(parkCalls).toHaveLength(2);
  });

  it("park accepts an immediate parked too", async () => {
    manager.parkStatuses.splice(0, manager.parkStatuses.length, "parked");
    const backend = backendFor();
    await expect(backend.parkHome("home-sbx1")).resolves.toBeUndefined();
  });

  it("park throws when never accepted within its ceiling", async () => {
    manager.parkStatuses.splice(0, manager.parkStatuses.length, "pending");
    const backend = backendFor({ parkWaitSeconds: 0 });
    await expect(backend.parkHome("home-sbx1")).rejects.toThrow(
      /never accepted/,
    );
  });

  it("wake polls to ready", async () => {
    manager.wakeStatuses.splice(
      0,
      manager.wakeStatuses.length,
      "waking",
      "waking",
      "ready",
    );
    const backend = backendFor();
    await backend.wakeHome("home-sbx1");
    const wakeCalls = manager.requests.filter((request) =>
      request.path.endsWith("/wake"),
    );
    expect(wakeCalls).toHaveLength(3);
  });

  it("wake throws at its ceiling — the caller must never map a half-restored home", async () => {
    manager.wakeStatuses.splice(0, manager.wakeStatuses.length, "waking");
    const backend = backendFor({ wakeWaitSeconds: 0 });
    await expect(backend.wakeHome("home-sbx1")).rejects.toThrow(
      /did not reach ready/,
    );
  });

  it("rides out a transient poll blip — one 500 mid-wake must not fail a restore in progress", async () => {
    manager.wakeStatuses.splice(
      0,
      manager.wakeStatuses.length,
      "waking",
      "ready",
    );
    manager.failNextRequests = 1; // the FIRST poll dies (manager mid-redeploy)
    const backend = backendFor();
    await expect(backend.wakeHome("home-sbx1")).resolves.toBeUndefined();
    manager.parkStatuses.splice(0, manager.parkStatuses.length, "parking");
    manager.failNextRequests = 1;
    await expect(backend.parkHome("home-sbx1")).resolves.toBeUndefined();
  });

  it("image watch survives poll blips and still returns the ref", async () => {
    manager.createRunning = false;
    const backend = backendFor({ imageWaitSeconds: 1 });
    backend.identify("rnr1");
    const pending = backend.createSandbox(spec());
    // Wait until the create itself landed, then blip the next watch polls.
    // The settled escape keeps a rejected create from spinning this loop
    // into the test timeout instead of failing the assertion below.
    let settled = false;
    void pending.catch(() => undefined).finally(() => (settled = true));
    while (manager.sandboxes.size === 0 && !settled) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    manager.failNextRequests = 2;
    for (const snapshot of manager.sandboxes.values()) snapshot.running = true;
    await expect(pending).resolves.toBe("pod-uid-1");
  });

  it("FAILS CLOSED against a step-2 manager's {ok:true} park answer — never reads skew as success", async () => {
    manager.legacyParkAnswers = true;
    const backend = backendFor();
    await expect(backend.parkHome("home-sbx1")).rejects.toMatchObject({
      name: "ManagerApiError",
      code: "unexpected_status",
    });
    await expect(backend.wakeHome("home-sbx1")).rejects.toMatchObject({
      code: "unexpected_status",
    });
  });

  it("retries a TRUNCATED body mid-poll — a dying pod's cut-off answer is transient, not terminal", async () => {
    manager.wakeStatuses.splice(
      0,
      manager.wakeStatuses.length,
      "waking",
      "ready",
    );
    manager.truncateNextBodies = 1; // the first poll's body is cut off
    const backend = backendFor();
    await expect(backend.wakeHome("home-sbx1")).resolves.toBeUndefined();
  });

  it("does NOT retry a deterministic 503 not_configured — fails fast, never burns the whole ceiling", async () => {
    const backend = backendFor({ wakeWaitSeconds: 60, parkWaitSeconds: 60 });
    manager.nextHomeError = {
      status: 503,
      code: "not_configured",
      message: "park/wake needs a bucket",
    };
    // Would hang ~60s if a 503 house refusal were treated as transient.
    await expect(backend.wakeHome("home-sbx1")).rejects.toMatchObject({
      code: "not_configured",
    });
    manager.nextHomeError = {
      status: 500,
      code: "archive_invalid",
      message: "no placement metadata",
    };
    await expect(backend.parkHome("home-sbx1")).rejects.toMatchObject({
      code: "archive_invalid",
    });
  });
});
