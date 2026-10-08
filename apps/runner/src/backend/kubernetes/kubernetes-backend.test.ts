import { describe, expect, it } from "vitest";
import {
  ANNOTATION_PAYLOAD,
  LABEL_INSTALLATION,
  LABEL_MANAGED,
  LABEL_ROLE,
  LABEL_RUNNER,
  LABEL_SANDBOX,
  assertInjectablePath,
  createKubernetesBackend,
  renderBootScript,
  renderEgressGate,
} from "./kubernetes-backend";
import { KubeApiError, KubeClient, type KubeTransport } from "./kube-client";
import { ImageUnavailableError, type SandboxSpec } from "../types";

/**
 * The kubernetes backend against a recording transport: every assertion is
 * about the SPEC it sends the API server (hardening, labels, mounts, the
 * egress gate), not about a live cluster; that is the kind/EKS lane's job.
 */

interface Recorded {
  method: string;
  path: string;
  body?: unknown;
}

const jsonBody = (value: unknown) => ({
  text: async () => JSON.stringify(value),
  dump: async () => {},
});

const service = (ip: string) => ({ spec: { clusterIP: ip } });

type Responder = (
  call: Recorded,
) => { statusCode: number; body: unknown } | null;

const createRecordingTransport = (
  responders: Responder[] = [],
): { transport: KubeTransport; calls: Recorded[] } => {
  const calls: Recorded[] = [];
  const transport: KubeTransport = {
    async request({ method, path, body }) {
      const parsed =
        typeof body === "string" ? (JSON.parse(body) as unknown) : undefined;
      const call: Recorded = {
        method,
        path,
        ...(parsed !== undefined && { body: parsed }),
      };
      calls.push(call);

      if (path === "/version") {
        return { statusCode: 200, body: jsonBody({ gitVersion: "v1.33.0" }) };
      }
      // Test-specific responders win over the defaults below.
      for (const responder of responders) {
        const answer = responder(call);
        if (answer) {
          return { statusCode: answer.statusCode, body: jsonBody(answer.body) };
        }
      }
      if (path.endsWith("/services/onecli-gateway")) {
        return { statusCode: 200, body: jsonBody(service("10.96.0.10")) };
      }
      if (path.endsWith("/services/onecli-runner")) {
        return { statusCode: 200, body: jsonBody(service("10.96.0.11")) };
      }
      if (path.endsWith("/services/onecli-api")) {
        return { statusCode: 200, body: jsonBody(service("10.96.0.12")) };
      }
      // Lists default to empty; creates echo a name; deletes are 200.
      if (method === "GET" && path.includes("labelSelector=")) {
        return { statusCode: 200, body: jsonBody({ items: [] }) };
      }
      return { statusCode: 200, body: jsonBody({ metadata: { name: "ok" } }) };
    },
    close: async () => {},
  };
  return { transport, calls };
};

const makeBackend = (
  responders: Responder[] = [],
  overrides: Partial<Parameters<typeof createKubernetesBackend>[0]> = {},
) => {
  const { transport, calls } = createRecordingTransport(responders);
  const backend = createKubernetesBackend({
    runnerId: "r-1",
    installationId: "inst-abc",
    namespace: "onecli-sandboxes",
    controlNamespace: "onecli",
    gatewayService: "onecli-gateway",
    gatewayPort: 10255,
    gatewayHost: "onecli-gateway",
    runnerService: "onecli-runner",
    runnerPort: 8484,
    runnerHost: "onecli-runner",
    apiService: "onecli-api",
    apiPort: 10256,
    storageClass: "gp3",
    homeSize: "20Gi",
    ephemeralStorageLimit: null,
    nodeSelector: {},
    tolerations: [],
    runtimeClassName: null,
    imagePullSecrets: [],
    egressGateTimeoutSeconds: 5,
    imageWaitSeconds: 0,
    pollIntervalMs: 1,
    client: new KubeClient(transport),
    ...overrides,
  });
  return { backend, calls };
};

const spec: SandboxSpec = {
  sandboxId: "sbx-1",
  workspaceId: "ws-1",
  image: "ghcr.io/onecli/onecli-agent:1.2.3",
  env: { HTTPS_PROXY: "http://x:aoc_secret@onecli-gateway:10255", FOO: "bar" },
  files: [
    { containerPath: "/tmp/onecli-gateway-ca.pem", content: "PEM" },
    {
      containerPath: "/home/node/.codex/auth.json",
      content: "{}",
      mode: 0o600,
    },
  ],
  homeRef: "onecli-home-sbx-1",
  limits: { memoryMb: 2048, cpus: 2, pids: 512 },
  payloadHash: "a".repeat(64),
};

/** The Job body the backend posted, or throws. */
const postedJob = (calls: Recorded[]) => {
  const call = calls.find(
    (c) => c.method === "POST" && c.path.endsWith("/jobs"),
  );
  if (!call) throw new Error("no Job was posted");
  return call.body as {
    metadata: {
      name: string;
      labels: Record<string, string>;
      annotations: Record<string, string>;
    };
    spec: {
      backoffLimit: number;
      template: {
        spec: {
          restartPolicy: string;
          automountServiceAccountToken: boolean;
          hostAliases: Array<{ ip: string; hostnames: string[] }>;
          securityContext: Record<string, unknown>;
          volumes: Array<Record<string, unknown>>;
          initContainers: Array<Record<string, unknown>>;
          containers: Array<Record<string, unknown>>;
        };
      };
    };
  };
};

const postedSecret = (calls: Recorded[]) => {
  const call = calls.find(
    (c) => c.method === "POST" && c.path.endsWith("/secrets"),
  );
  if (!call) throw new Error("no Secret was posted");
  return call.body as {
    metadata: { name: string; labels: Record<string, string> };
    stringData: Record<string, string>;
  };
};

describe("prepare", () => {
  it("resolves the gateway, runner and api ClusterIPs from the release namespace", async () => {
    const { backend, calls } = makeBackend();
    await backend.prepare();
    const services = calls.filter((c) => c.path.includes("/services/"));
    expect(services.map((c) => c.path)).toEqual([
      "/api/v1/namespaces/onecli/services/onecli-gateway",
      "/api/v1/namespaces/onecli/services/onecli-runner",
      "/api/v1/namespaces/onecli/services/onecli-api",
    ]);
  });

  it("refuses a headless Service: a sandbox needs a routable address", async () => {
    const { backend } = makeBackend([
      (c) =>
        c.path.endsWith("/services/onecli-gateway")
          ? { statusCode: 200, body: { spec: { clusterIP: "None" } } }
          : null,
    ]);
    await expect(backend.prepare()).rejects.toThrow(/no ClusterIP/);
  });

  it("refuses createSandbox before prepare", async () => {
    const { backend } = makeBackend();
    await expect(backend.createSandbox(spec)).rejects.toThrow(/before prepare/);
  });
});

describe("createSandbox: the pod spec is the tenant boundary", () => {
  it("runs unprivileged as uid 1000 with every capability dropped and the default seccomp profile", async () => {
    const { backend, calls } = makeBackend();
    await backend.prepare();
    await backend.createSandbox(spec);
    const pod = postedJob(calls).spec.template.spec;

    expect(pod.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      fsGroupChangePolicy: "OnRootMismatch",
      seccompProfile: { type: "RuntimeDefault" },
    });
    for (const container of [...pod.initContainers, ...pod.containers]) {
      const sc = container.securityContext as Record<string, unknown>;
      expect(sc.allowPrivilegeEscalation).toBe(false);
      expect(sc.capabilities).toEqual({ drop: ["ALL"] });
      expect(sc).not.toHaveProperty("privileged");
    }
    expect(pod.automountServiceAccountToken).toBe(false);
  });

  it("never restarts on its own: backoffLimit 0 and restartPolicy Never", async () => {
    const { backend, calls } = makeBackend();
    await backend.prepare();
    await backend.createSandbox(spec);
    const job = postedJob(calls);
    expect(job.spec.backoffLimit).toBe(0);
    expect(job.spec.template.spec.restartPolicy).toBe("Never");
  });

  it("mounts ONLY the home PVC and the read-only payload Secret: no hostPath, no socket", async () => {
    const { backend, calls } = makeBackend();
    await backend.prepare();
    await backend.createSandbox(spec);
    const pod = postedJob(calls).spec.template.spec;
    expect(pod.volumes).toHaveLength(2);
    expect(pod.volumes[0]).toEqual({
      name: "home",
      persistentVolumeClaim: { claimName: "onecli-home-sbx-1" },
    });
    expect(pod.volumes[1]).toMatchObject({
      name: "init",
      secret: { defaultMode: 0o400 },
    });
    const mounts = pod.containers[0]?.volumeMounts as Array<{
      name: string;
      readOnly?: boolean;
    }>;
    expect(mounts.find((m) => m.name === "init")?.readOnly).toBe(true);
  });

  it("pre-resolves the gateway and runner into hostAliases so the namespace needs no DNS", async () => {
    const { backend, calls } = makeBackend();
    await backend.prepare();
    await backend.createSandbox(spec);
    expect(postedJob(calls).spec.template.spec.hostAliases).toEqual([
      { ip: "10.96.0.10", hostnames: ["onecli-gateway"] },
      { ip: "10.96.0.11", hostnames: ["onecli-runner"] },
    ]);
  });

  it("gates the workload behind an egress check against the api ClusterIP", async () => {
    const { backend, calls } = makeBackend();
    await backend.prepare();
    await backend.createSandbox(spec);
    const pod = postedJob(calls).spec.template.spec;
    const gate = pod.initContainers[0] as {
      name: string;
      image: string;
      command: string[];
      env: Array<{ name: string; value: string }>;
    };
    expect(gate.name).toBe("egress-gate");
    // The agent image itself: no extra image to pull or trust.
    expect(gate.image).toBe(spec.image);
    expect(gate.command).toEqual(["/bin/sh", "/onecli-init/egress-gate.sh"]);
    expect(gate.env).toEqual([
      { name: "ONECLI_EGRESS_GATE_DENY", value: "10.96.0.12:10256" },
      { name: "ONECLI_EGRESS_GATE_ALLOW", value: "onecli-runner:8484" },
    ]);
    const script = postedSecret(calls).stringData["egress-gate.sh"];
    expect(script).toContain("exit 1");
    expect(script).toContain("refusing to start");
  });

  it("carries the token-bearing env through the Secret, never inline in the Job", async () => {
    const { backend, calls } = makeBackend();
    await backend.prepare();
    await backend.createSandbox(spec);
    const secret = postedSecret(calls);
    expect(secret.stringData["env-HTTPS_PROXY"]).toBe(spec.env.HTTPS_PROXY);
    const job = JSON.stringify(postedJob(calls));
    expect(job).not.toContain("aoc_secret");
    const env = postedJob(calls).spec.template.spec.containers[0]
      ?.env as Array<{
      name: string;
      valueFrom?: { secretKeyRef: { name: string; key: string } };
    }>;
    const proxy = env.find((e) => e.name === "HTTPS_PROXY");
    expect(proxy?.valueFrom?.secretKeyRef).toEqual({
      name: secret.metadata.name,
      key: "env-HTTPS_PROXY",
    });
  });

  it("installs payload files as the unprivileged user via the boot wrapper, then execs the image entrypoint", async () => {
    const { backend, calls } = makeBackend();
    await backend.prepare();
    await backend.createSandbox(spec);
    const secret = postedSecret(calls);
    expect(secret.stringData["file-0"]).toBe("PEM");
    expect(secret.stringData["file-1"]).toBe("{}");
    const boot = secret.stringData["boot.sh"];
    expect(boot).toContain(
      "install -D -m 0644 '/onecli-init/file-0' '/tmp/onecli-gateway-ca.pem'",
    );
    expect(boot).toContain(
      "install -D -m 0600 '/onecli-init/file-1' '/home/node/.codex/auth.json'",
    );
    expect(boot).toContain('exec "$@"');
    const command = postedJob(calls).spec.template.spec.containers[0]?.command;
    expect(command).toEqual([
      "/usr/bin/tini",
      "--",
      "/bin/sh",
      "/onecli-init/boot.sh",
      "./agent-entrypoint.sh",
    ]);
  });

  it("labels every object so reconcile, the orphan sweep and the NetworkPolicy can find it", async () => {
    const { backend, calls } = makeBackend();
    await backend.prepare();
    await backend.createSandbox(spec);
    const job = postedJob(calls);
    expect(job.metadata.labels).toMatchObject({
      [LABEL_MANAGED]: "1",
      [LABEL_SANDBOX]: "sbx-1",
      [LABEL_RUNNER]: "r-1",
      [LABEL_INSTALLATION]: "inst-abc",
      [LABEL_ROLE]: "sandbox",
    });
    // The 64-char hash would overflow a label value: it rides an annotation.
    expect(job.metadata.annotations[ANNOTATION_PAYLOAD]).toBe("a".repeat(64));
    expect(postedSecret(calls).metadata.labels[LABEL_SANDBOX]).toBe("sbx-1");
  });

  it("adopts the stable runner id after identify()", async () => {
    const { backend, calls } = makeBackend();
    await backend.prepare();
    backend.identify("stable-runner-id");
    await backend.createSandbox(spec);
    expect(postedJob(calls).metadata.labels[LABEL_RUNNER]).toBe(
      "stable-runner-id",
    );
  });

  it("applies memory as request==limit and CPU as a quarter request under the full ceiling", async () => {
    const { backend, calls } = makeBackend();
    await backend.prepare();
    await backend.createSandbox(spec);
    const resources =
      postedJob(calls).spec.template.spec.containers[0]?.resources;
    expect(resources).toEqual({
      requests: { memory: "2048Mi", cpu: "500m" },
      limits: { memory: "2048Mi", cpu: "2" },
    });
  });

  it("caps node-local scratch when an ephemeral-storage limit is configured", async () => {
    const { backend, calls } = makeBackend([], {
      ephemeralStorageLimit: "4Gi",
    });
    await backend.prepare();
    await backend.createSandbox(spec);
    const resources =
      postedJob(calls).spec.template.spec.containers[0]?.resources;
    expect(resources).toEqual({
      requests: { memory: "2048Mi", cpu: "500m" },
      limits: { memory: "2048Mi", cpu: "2", "ephemeral-storage": "4Gi" },
    });
  });

  it("passes scheduling knobs through only when set", async () => {
    const { backend, calls } = makeBackend([], {
      nodeSelector: { "onecli.sh/pool": "sandboxes" },
      tolerations: [{ key: "onecli.sh/sandbox", operator: "Exists" }],
      runtimeClassName: "gvisor",
      imagePullSecrets: ["regcred"],
    });
    await backend.prepare();
    await backend.createSandbox(spec);
    const pod = postedJob(calls).spec.template.spec as Record<string, unknown>;
    expect(pod.nodeSelector).toEqual({ "onecli.sh/pool": "sandboxes" });
    expect(pod.tolerations).toEqual([
      { key: "onecli.sh/sandbox", operator: "Exists" },
    ]);
    expect(pod.runtimeClassName).toBe("gvisor");
    expect(pod.imagePullSecrets).toEqual([{ name: "regcred" }]);

    const plain = makeBackend();
    await plain.backend.prepare();
    await plain.backend.createSandbox(spec);
    const plainPod = postedJob(plain.calls).spec.template.spec as Record<
      string,
      unknown
    >;
    expect(plainPod).not.toHaveProperty("nodeSelector");
    expect(plainPod).not.toHaveProperty("tolerations");
    expect(plainPod).not.toHaveProperty("runtimeClassName");
  });

  it("cleans up the Secret when the Job create fails", async () => {
    const { backend, calls } = makeBackend([
      (c) =>
        c.method === "POST" && c.path.endsWith("/jobs")
          ? { statusCode: 403, body: { message: "quota exceeded" } }
          : null,
    ]);
    await backend.prepare();
    await expect(backend.createSandbox(spec)).rejects.toBeInstanceOf(
      KubeApiError,
    );
    const secretDelete = calls.find(
      (c) =>
        c.method === "DELETE" &&
        c.path.includes("/secrets/onecli-sandbox-sbx-1-"),
    );
    expect(secretDelete).toBeDefined();
  });

  it("turns an image-pull refusal into the typed ImageUnavailableError and removes the spawn", async () => {
    const { backend, calls } = makeBackend(
      [
        (c) =>
          c.method === "GET" && c.path.includes("/pods?")
            ? {
                statusCode: 200,
                body: {
                  items: [
                    {
                      metadata: {
                        name: "p",
                        labels: { "sh.onecli.spawn": "abc" },
                      },
                      status: {
                        phase: "Pending",
                        containerStatuses: [
                          {
                            state: { waiting: { reason: "ImagePullBackOff" } },
                          },
                        ],
                      },
                    },
                  ],
                },
              }
            : null,
      ],
      { imageWaitSeconds: 1 },
    );
    await backend.prepare();
    await expect(backend.createSandbox(spec)).rejects.toBeInstanceOf(
      ImageUnavailableError,
    );
    expect(
      calls.some(
        (c) =>
          c.method === "DELETE" &&
          c.path.includes("/jobs/onecli-sandbox-sbx-1-"),
      ),
    ).toBe(true);
  });

  it("sees an image-pull refusal on the INIT container through the main container's PodInitializing", async () => {
    // The gate init container pulls the same image first; when that pull
    // fails, the main container's status is the bland `PodInitializing`.
    const { backend } = makeBackend(
      [
        (c) =>
          c.method === "GET" && c.path.includes("/pods?")
            ? {
                statusCode: 200,
                body: {
                  items: [
                    {
                      metadata: {
                        name: "p",
                        labels: { "sh.onecli.spawn": "abc" },
                      },
                      status: {
                        phase: "Pending",
                        initContainerStatuses: [
                          { state: { waiting: { reason: "ErrImagePull" } } },
                        ],
                        containerStatuses: [
                          { state: { waiting: { reason: "PodInitializing" } } },
                        ],
                      },
                    },
                  ],
                },
              }
            : null,
      ],
      { imageWaitSeconds: 1 },
    );
    await backend.prepare();
    await expect(backend.createSandbox(spec)).rejects.toBeInstanceOf(
      ImageUnavailableError,
    );
  });

  it("refuses payload paths that target the home, the init mount, or system directories", () => {
    for (const bad of [
      "/workspace/x",
      "/workspace",
      "/onecli-init/x",
      "/usr/local/bin/node",
      "/etc/passwd",
      "/var/run/secrets/x",
      "relative/path",
      "/a/../b",
      "/with space",
    ]) {
      expect(() => assertInjectablePath(bad), bad).toThrow();
    }
    expect(() =>
      assertInjectablePath("/tmp/onecli-gateway-ca.pem"),
    ).not.toThrow();
    expect(() =>
      assertInjectablePath("/home/node/.codex/auth.json"),
    ).not.toThrow();
  });
});

describe("homes", () => {
  it("provisions a PVC with the configured class and size, tolerating an existing one", async () => {
    const { backend, calls } = makeBackend([
      (c) =>
        c.method === "POST" && c.path.endsWith("/persistentvolumeclaims")
          ? { statusCode: 409, body: { reason: "AlreadyExists" } }
          : null,
    ]);
    await backend.prepare();
    const ref = await backend.provisionHome("sbx-1");
    expect(ref).toBe("onecli-home-sbx-1");
    const post = calls.find(
      (c) => c.method === "POST" && c.path.endsWith("/persistentvolumeclaims"),
    );
    expect(post?.body).toMatchObject({
      metadata: {
        name: "onecli-home-sbx-1",
        labels: { [LABEL_SANDBOX]: "sbx-1" },
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: "gp3",
        resources: { requests: { storage: "20Gi" } },
      },
    });
  });

  it("omits storageClassName when none is configured (the cluster default applies)", async () => {
    const { backend, calls } = makeBackend([], { storageClass: null });
    await backend.prepare();
    await backend.provisionHome("sbx-1");
    const post = calls.find(
      (c) => c.method === "POST" && c.path.endsWith("/persistentvolumeclaims"),
    );
    expect(
      (post?.body as { spec: Record<string, unknown> }).spec,
    ).not.toHaveProperty("storageClassName");
  });

  it("park and wake are no-ops: the claim is resident", async () => {
    const { backend, calls } = makeBackend();
    await backend.prepare();
    const before = calls.length;
    await backend.parkHome("onecli-home-sbx-1");
    await backend.wakeHome("onecli-home-sbx-1", "ws-1");
    expect(calls.length).toBe(before);
    expect(backend.homeDurability).toBe("resident");
  });
});

describe("lifecycle", () => {
  it("stop deletes the Job in the foreground with the supervisor's grace period, then waits for it to be gone", async () => {
    // The first GET after the delete still sees the Job (deletionTimestamp
    // set, pod draining); the second sees 404. Stop must return only then.
    let gets = 0;
    const { backend, calls } = makeBackend([
      (c) => {
        if (
          c.method === "GET" &&
          c.path.endsWith("/jobs/onecli-sandbox-sbx-1-abc")
        ) {
          gets += 1;
          return gets === 1
            ? {
                statusCode: 200,
                body: {
                  metadata: { deletionTimestamp: "2026-01-01T00:00:00Z" },
                },
              }
            : { statusCode: 404, body: {} };
        }
        return null;
      },
    ]);
    await backend.prepare();
    await backend.stopSandbox("onecli-sandbox-sbx-1-abc");
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.path).toBe(
      "/apis/batch/v1/namespaces/onecli-sandboxes/jobs/onecli-sandbox-sbx-1-abc?propagationPolicy=Foreground&gracePeriodSeconds=30",
    );
    expect(gets).toBe(2);
  });

  it("remove deletes the Job and its payload Secret, tolerating absence", async () => {
    const { backend, calls } = makeBackend([
      (c) => (c.method === "DELETE" ? { statusCode: 404, body: {} } : null),
    ]);
    await backend.prepare();
    await expect(
      backend.removeSandbox("onecli-sandbox-sbx-1-abc"),
    ).resolves.toBeUndefined();
    expect(
      calls
        .filter((c) => c.method === "DELETE")
        .map((c) => c.path.split("?")[0]),
    ).toEqual([
      "/apis/batch/v1/namespaces/onecli-sandboxes/jobs/onecli-sandbox-sbx-1-abc",
      "/api/v1/namespaces/onecli-sandboxes/secrets/onecli-sandbox-sbx-1-abc",
    ]);
  });

  it("reports the pod phase, and a Job with no pod as terminal", async () => {
    const jobs = {
      items: [
        {
          metadata: {
            name: "onecli-sandbox-sbx-1-abc",
            labels: { [LABEL_SANDBOX]: "sbx-1", [LABEL_RUNNER]: "r-1" },
            annotations: { [ANNOTATION_PAYLOAD]: "h1" },
          },
        },
        {
          metadata: {
            name: "onecli-sandbox-sbx-2-def",
            labels: { [LABEL_SANDBOX]: "sbx-2", [LABEL_RUNNER]: "r-1" },
          },
        },
      ],
    };
    const { backend } = makeBackend([
      (c) =>
        c.path.includes("/jobs?") ? { statusCode: 200, body: jobs } : null,
      (c) =>
        c.path.includes("/pods?") && c.path.includes("sbx-1")
          ? {
              statusCode: 200,
              body: {
                items: [
                  {
                    metadata: { name: "p1", labels: {} },
                    status: { phase: "Running" },
                  },
                ],
              },
            }
          : null,
    ]);
    await backend.prepare();
    const snapshots = await backend.listSandboxes();
    expect(snapshots).toEqual([
      {
        sandboxId: "sbx-1",
        containerRef: "onecli-sandbox-sbx-1-abc",
        running: true,
        payloadHash: "h1",
        phase: "Running",
      },
      {
        sandboxId: "sbx-2",
        containerRef: "onecli-sandbox-sbx-2-def",
        running: false,
        payloadHash: null,
        phase: "Failed",
      },
    ]);
  });

  it("listManaged enumerates every managed Job and PVC regardless of runner id", async () => {
    const { backend, calls } = makeBackend([
      (c) =>
        c.path.includes("/jobs?")
          ? {
              statusCode: 200,
              body: {
                items: [
                  {
                    metadata: {
                      name: "onecli-sandbox-old-x",
                      labels: {
                        [LABEL_SANDBOX]: "old",
                        [LABEL_RUNNER]: "dead",
                        [LABEL_INSTALLATION]: "inst-abc",
                      },
                      creationTimestamp: "2026-01-01T00:00:00Z",
                    },
                  },
                ],
              },
            }
          : null,
      (c) =>
        c.path.includes("/persistentvolumeclaims?")
          ? {
              statusCode: 200,
              body: {
                items: [
                  {
                    metadata: {
                      name: "onecli-home-old",
                      labels: { [LABEL_SANDBOX]: "old" },
                    },
                  },
                ],
              },
            }
          : null,
    ]);
    await backend.prepare();
    const managed = await backend.listManaged();
    expect(managed).toEqual([
      {
        kind: "sandbox",
        ref: "onecli-sandbox-old-x",
        sandboxId: "old",
        runnerId: "dead",
        installationId: "inst-abc",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        kind: "home",
        ref: "onecli-home-old",
        sandboxId: "old",
        runnerId: null,
        installationId: null,
        createdAt: null,
      },
    ]);
    // Managed-label only, never the owner filter.
    const lists = calls.filter(
      (c) => c.method === "GET" && c.path.includes("labelSelector="),
    );
    for (const call of lists.slice(-2)) {
      expect(decodeURIComponent(call.path)).toContain("sh.onecli.managed=1");
      expect(decodeURIComponent(call.path)).not.toContain("runner-id");
    }
  });
});

describe("scripts", () => {
  it("single-quotes every path in the boot script", () => {
    const script = renderBootScript([
      { secretKey: "file-0", containerPath: "/tmp/it's", mode: 0o600 },
    ]);
    expect(script).toContain(
      `install -D -m 0600 '/onecli-init/file-0' '/tmp/it'\\''s'`,
    );
  });

  it("the egress gate needs BOTH the deny probe refused and the allow probe answered", () => {
    const script = renderEgressGate(30);
    expect(script).toContain("7|28)");
    expect(script).toContain("-lt 60");
    // Fail-closed in both directions: a dead network must not read as a fence.
    expect(script).toContain('if [ "$allow" -eq 0 ]');
    expect(script).toContain("$ONECLI_EGRESS_GATE_ALLOW/healthz");
    expect(script).toContain("exit 1");
  });

  it("the egress gate script runs under sh: refused deny + ok allow passes, ok deny fails, dead allow fails", async () => {
    // Execute the rendered script with curl stubbed through PATH, so the
    // shell logic itself is what is tested, not a reading of it.
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "egress-gate-"));
    try {
      writeFileSync(join(dir, "gate.sh"), renderEgressGate(1));
      // The stub returns the rc its URL asks for: .../rc7 → 7, .../rc0 → 0.
      writeFileSync(
        join(dir, "curl"),
        '#!/bin/sh\nfor a in "$@"; do :; done\ncase "$a" in *deny-refused*) exit 7;; *deny-open*) exit 0;; *allow-ok*) exit 0;; *allow-dead*) exit 7;; esac\nexit 1\n',
      );
      chmodSync(join(dir, "curl"), 0o755);
      const run = (deny: string, allow: string) => {
        try {
          execFileSync("sh", [join(dir, "gate.sh")], {
            env: {
              PATH: `${dir}:/usr/bin:/bin`,
              ONECLI_EGRESS_GATE_DENY: deny,
              ONECLI_EGRESS_GATE_ALLOW: allow,
            },
            stdio: "pipe",
          });
          return 0;
        } catch (error) {
          return (error as { status: number }).status;
        }
      };
      expect(run("deny-refused", "allow-ok")).toBe(0);
      expect(run("deny-open", "allow-ok")).toBe(1);
      expect(run("deny-refused", "allow-dead")).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
