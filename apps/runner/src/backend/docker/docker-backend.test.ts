import { describe, expect, it } from "vitest";
import { createDockerBackend } from "./docker-backend";
import { encodeFilters, type EngineTransport } from "./engine-client";
import { ImageUnavailableError, type SandboxBackend } from "../types";

/**
 * The Docker backend against a recording transport: no daemon needed, and the
 * assertions are about the REQUESTS — which is where the security properties
 * live (the isolated network, the single mount, the resource limits).
 */

interface Recorded {
  method: string;
  path: string;
  body?: unknown;
}

const jsonBody = (value: unknown) => ({
  text: async () => JSON.stringify(value),
  json: async () => value,
  dump: async () => {},
});

const createRecordingTransport = (
  responses: Record<string, unknown> = {},
): { transport: EngineTransport; calls: Recorded[] } => {
  const calls: Recorded[] = [];

  const transport: EngineTransport = {
    async request({ method, path, body }) {
      const parsedBody =
        typeof body === "string" ? (JSON.parse(body) as unknown) : undefined;
      calls.push({
        method,
        path,
        ...(parsedBody !== undefined && { body: parsedBody }),
      });

      if (path.endsWith("/version")) {
        return {
          statusCode: 200,
          body: jsonBody({ ApiVersion: "1.47", MinAPIVersion: "1.24" }),
        };
      }
      for (const [match, value] of Object.entries(responses)) {
        if (path.includes(match)) {
          return { statusCode: 200, body: jsonBody(value) };
        }
      }
      return { statusCode: 200, body: jsonBody({ Id: "cont-created" }) };
    },
    close: async () => {},
  };

  return { transport, calls };
};

const makeBackend = (
  responses: Record<string, unknown> = {},
  overrides: { networkInternal?: boolean; extraHosts?: string[] } = {},
) => {
  const { transport, calls } = createRecordingTransport(responses);
  const backend: SandboxBackend = createDockerBackend({
    runnerId: "r-1",
    installationId: "inst-abc",
    network: "onecli-sandboxes",
    networkInternal: overrides.networkInternal ?? true,
    socketPath: "/var/run/docker.sock",
    ...(overrides.extraHosts && { extraHosts: overrides.extraHosts }),
    transport,
  });
  return { backend, calls };
};

const spec = {
  sandboxId: "sb-1",
  image: "onecli-agent:test",
  env: {
    HTTPS_PROXY: "http://x:aoc_t@gateway:10255",
    ANTHROPIC_API_KEY: "placeholder",
  },
  files: [{ containerPath: "/tmp/onecli-gateway-ca.pem", content: "PEM" }],
  homeRef: "onecli-home-sb-1",
  limits: { memoryMb: 1024, cpus: 2, pids: 256 },
  payloadHash: "hash-1",
};

describe("prepare", () => {
  it("negotiates the API version and pins it into every later path", async () => {
    const { backend, calls } = makeBackend({ "/networks?": [] });
    await backend.prepare();
    await backend.provisionHome("sb-1");

    expect(calls[0]?.path).toBe("/version");
    expect(calls.at(-1)?.path).toBe("/v1.44/volumes/create");
  });

  it("clamps to the daemon's version when the daemon is older", async () => {
    const { transport, calls } = createRecordingTransport({ "/networks?": [] });
    const older: EngineTransport = {
      async request(options) {
        if (options.path.endsWith("/version")) {
          calls.push({ method: options.method, path: options.path });
          return {
            statusCode: 200,
            body: jsonBody({ ApiVersion: "1.41", MinAPIVersion: "1.24" }),
          };
        }
        return transport.request(options);
      },
      close: async () => {},
    };
    const backend = createDockerBackend({
      runnerId: "r-1",
      installationId: "inst-abc",
      network: "onecli-sandboxes",
      networkInternal: true,
      socketPath: "/sock",
      transport: older,
    });

    await backend.prepare();
    await backend.provisionHome("sb-1");

    expect(calls.at(-1)?.path).toBe("/v1.41/volumes/create");
  });

  it("creates the sandbox network as INTERNAL — the egress boundary", async () => {
    const { backend, calls } = makeBackend({ "/networks?": [] });
    await backend.prepare();

    const create = calls.find((call) => call.path.endsWith("/networks/create"));
    expect(create?.body).toMatchObject({
      Name: "onecli-sandboxes",
      Internal: true,
    });
  });

  it("REFUSES to run when the existing network is not isolated", async () => {
    // Fail closed: reusing a routable network would give every sandbox direct
    // internet egress while the stack looked healthy.
    const { backend } = makeBackend({
      "/networks?": [{ Name: "onecli-sandboxes", Internal: false }],
    });

    await expect(backend.prepare()).rejects.toThrow(/NOT internal/);
  });

  it("accepts an existing isolated network when isolation was asked for", async () => {
    const { backend } = makeBackend({
      "/networks?": [{ Name: "onecli-sandboxes", Internal: true }],
    });
    await expect(backend.prepare()).resolves.toBeUndefined();
  });

  it("does not recreate an existing network", async () => {
    const { backend, calls } = makeBackend({
      "/networks?": [{ Name: "onecli-sandboxes", Internal: true }],
    });
    await backend.prepare();

    expect(calls.some((call) => call.path.endsWith("/networks/create"))).toBe(
      false,
    );
  });
});

describe("createSandbox", () => {
  it("mounts ONLY the home volume — never the socket or host paths", async () => {
    const { backend, calls } = makeBackend({ "/networks?": [] });
    await backend.prepare();
    await backend.createSandbox(spec);

    const create = calls.find((call) =>
      call.path.includes("/containers/create"),
    );
    const hostConfig = (create?.body as { HostConfig: { Binds: string[] } })
      .HostConfig;
    expect(hostConfig.Binds).toEqual(["onecli-home-sb-1:/workspace"]);
    expect(JSON.stringify(create?.body)).not.toContain("docker.sock");
    expect(JSON.stringify(create?.body)).not.toContain("/app/data");
  });

  it("joins the isolated network and applies the resource limits", async () => {
    const { backend, calls } = makeBackend({ "/networks?": [] });
    await backend.prepare();
    await backend.createSandbox(spec);

    const create = calls.find((call) =>
      call.path.includes("/containers/create"),
    );
    expect(
      (create?.body as { HostConfig: Record<string, unknown> }).HostConfig,
    ).toMatchObject({
      NetworkMode: "onecli-sandboxes",
      Memory: 1024 * 1024 * 1024,
      NanoCpus: 2e9,
      PidsLimit: 256,
      SecurityOpt: ["no-new-privileges"],
    });
  });

  it("drops every capability and pins the unprivileged user", async () => {
    const { backend, calls } = makeBackend({ "/networks?": [] });
    await backend.prepare();
    await backend.createSandbox(spec);

    const create = calls.find((call) =>
      call.path.includes("/containers/create"),
    );
    expect(create?.body).toMatchObject({ User: "node" });
    expect(
      (create?.body as { HostConfig: { CapDrop: string[] } }).HostConfig
        .CapDrop,
    ).toEqual(["ALL"]);
  });

  it("never weakens the daemon's default seccomp profile (the shared-kernel userns gate)", async () => {
    // The agent image ships podman; on this SHARED kernel the default seccomp
    // profile is what actually blocks the `unshare`/`clone` namespace syscalls
    // rootless containers need (CapDrop:ALL + no-new-privileges disarm the
    // capability and setuid paths, but seccomp is the syscall gate). A
    // `seccomp=unconfined` SecurityOpt here would silently re-open rootless
    // podman on the shared kernel — assert no SecurityOpt touches seccomp.
    const { backend, calls } = makeBackend({ "/networks?": [] });
    await backend.prepare();
    await backend.createSandbox(spec);

    const create = calls.find((call) =>
      call.path.includes("/containers/create"),
    );
    const securityOpt = (
      create?.body as { HostConfig: { SecurityOpt: string[] } }
    ).HostConfig.SecurityOpt;
    expect(securityOpt).toEqual(["no-new-privileges"]);
    expect(securityOpt.some((opt) => opt.includes("seccomp"))).toBe(false);
  });

  it("labels the container for reconcile, including the payload hash", async () => {
    const { backend, calls } = makeBackend({ "/networks?": [] });
    await backend.prepare();
    await backend.createSandbox(spec);

    const create = calls.find((call) =>
      call.path.includes("/containers/create"),
    );
    expect((create?.body as { Labels: Record<string, string> }).Labels).toEqual(
      {
        "sh.onecli.managed": "1",
        "sh.onecli.sandbox-id": "sb-1",
        "sh.onecli.runner-id": "r-1",
        "sh.onecli.payload-hash": "hash-1",
        "sh.onecli.installation": "inst-abc",
      },
    );
  });

  it("writes the files into the container BEFORE it is started", async () => {
    const { backend, calls } = makeBackend({ "/networks?": [] });
    await backend.prepare();
    const ref = await backend.createSandbox(spec);
    await backend.startSandbox(ref);

    // The PUT specifically — the existence probe is also an /archive call.
    const archiveIndex = calls.findIndex(
      (call) => call.method === "PUT" && call.path.includes("/archive"),
    );
    const startIndex = calls.findIndex((call) => call.path.includes("/start"));
    expect(archiveIndex).toBeGreaterThan(-1);
    expect(archiveIndex).toBeLessThan(startIndex);
    expect(calls[archiveIndex]?.path).toContain(encodeURIComponent("/tmp"));
  });

  it("renders env as KEY=value pairs", async () => {
    const { backend, calls } = makeBackend({ "/networks?": [] });
    await backend.prepare();
    await backend.createSandbox(spec);

    const create = calls.find((call) =>
      call.path.includes("/containers/create"),
    );
    expect((create?.body as { Env: string[] }).Env).toEqual([
      "HTTPS_PROXY=http://x:aoc_t@gateway:10255",
      "ANTHROPIC_API_KEY=placeholder",
    ]);
  });
});

describe("putFiles (payload file injection)", () => {
  /**
   * A transport with a tiny stateful filesystem: HEAD /archive answers from
   * the set of existing paths, PUT /archive registers what its tar declares,
   * and every call is recorded in order — so the ancestor walk BITES here. A
   * 200-for-everything default (the generic recording transport) would let a
   * wrong PUT target or a duplicate directory entry pass vacuously.
   */
  const createArchiveTransport = (existingPaths: string[]) => {
    const calls: Array<{ method: string; path: string; raw?: Buffer }> = [];
    const existing = new Set(existingPaths);

    const queryPath = (path: string): string =>
      new URLSearchParams(path.split("?")[1] ?? "").get("path") ?? "";

    const transport: EngineTransport = {
      async request({ method, path, body }) {
        calls.push({
          method,
          path,
          ...(Buffer.isBuffer(body) && { raw: body }),
        });

        if (path.endsWith("/version")) {
          return {
            statusCode: 200,
            body: jsonBody({ ApiVersion: "1.47", MinAPIVersion: "1.24" }),
          };
        }
        if (path.includes("/archive")) {
          const target = queryPath(path);
          if (method === "HEAD") {
            return {
              statusCode: existing.has(target) ? 200 : 404,
              body: jsonBody(""),
            };
          }
          // PUT: register the extraction results so a later group's probe
          // sees them, exactly as a real daemon would.
          if (Buffer.isBuffer(body)) {
            for (const entry of parseTarEntries(body)) {
              existing.add(
                `${target}/${entry.name}`
                  .replace(/\/+/g, "/")
                  .replace(/\/$/, ""),
              );
            }
          }
          return { statusCode: 200, body: jsonBody({}) };
        }
        return { statusCode: 200, body: jsonBody({ Id: "cont-created" }) };
      },
      close: async () => {},
    };

    return { transport, calls };
  };

  /** Decode the headers of every entry in a USTAR archive. */
  const parseTarEntries = (archive: Buffer) => {
    const entries: Array<{
      name: string;
      typeflag: string;
      mode: number;
      uid: number;
      gid: number;
      size: number;
    }> = [];
    let offset = 0;
    while (offset + 512 <= archive.length) {
      const name = archive
        .subarray(offset, offset + 100)
        .toString("utf8")
        .replace(/\0+$/, "");
      if (!name) break;
      const octal = (at: number, length: number) =>
        parseInt(
          archive
            .subarray(offset + at, offset + at + length)
            .toString("ascii")
            .replace(/\0+$/, ""),
          8,
        );
      const size = octal(124, 11);
      entries.push({
        name,
        typeflag: archive
          .subarray(offset + 156, offset + 157)
          .toString("ascii"),
        mode: octal(100, 7),
        uid: octal(108, 7),
        gid: octal(116, 7),
        size,
      });
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    return entries;
  };

  const makeArchiveBackend = (existingPaths: string[]) => {
    const { transport, calls } = createArchiveTransport(existingPaths);
    const backend = createDockerBackend({
      runnerId: "r-1",
      installationId: "inst-abc",
      network: "onecli-sandboxes",
      networkInternal: true,
      socketPath: "/var/run/docker.sock",
      transport,
    });
    return { backend, calls };
  };

  const archiveCalls = (calls: Array<{ method: string; path: string }>) =>
    calls
      .filter((call) => call.path.includes("/archive"))
      .map((call) => ({
        method: call.method,
        target: new URLSearchParams(call.path.split("?")[1] ?? "").get("path"),
      }));

  const codexSpec = {
    ...spec,
    files: [
      { containerPath: "/tmp/onecli-gateway-ca.pem", content: "PEM" },
      {
        containerPath: "/home/node/.codex/auth.json",
        content: "{}",
        mode: 0o600,
      },
    ],
  };

  it("existing target dir: ONE probe, direct PUT, zero directory entries", async () => {
    const { backend, calls } = makeArchiveBackend(["/tmp"]);
    await backend.createSandbox({ ...spec });

    expect(archiveCalls(calls)).toEqual([
      { method: "HEAD", target: "/tmp" },
      { method: "PUT", target: "/tmp" },
    ]);
    const put = calls.find((call) => call.method === "PUT" && call.raw);
    const entries = parseTarEntries(put!.raw!);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "onecli-gateway-ca.pem",
      typeflag: "0",
      mode: 0o644,
      uid: 1000,
      gid: 1000,
    });
  });

  it("missing dir: walks to the deepest EXISTING ancestor and creates the chain node-owned", async () => {
    // The codex shape: /home/node exists in the image, .codex does not.
    const { backend, calls } = makeArchiveBackend(["/tmp", "/home/node"]);
    await backend.createSandbox(codexSpec);

    expect(archiveCalls(calls)).toEqual([
      { method: "HEAD", target: "/tmp" },
      { method: "PUT", target: "/tmp" },
      { method: "HEAD", target: "/home/node/.codex" },
      { method: "HEAD", target: "/home/node" },
      // The PUT lands on the ancestor that EXISTS — the target dir rides
      // inside the archive.
      { method: "PUT", target: "/home/node" },
    ]);

    const puts = calls.filter((call) => call.method === "PUT" && call.raw);
    const stubEntries = parseTarEntries(puts[1]!.raw!);
    expect(stubEntries).toEqual([
      // Chain first, node-owned and writable by the workload — never
      // root-owned dirs the agent cannot use (the cloud boot script's
      // `install -d -o node -g node` contract).
      {
        name: ".codex/",
        typeflag: "5",
        mode: 0o755,
        uid: 1000,
        gid: 1000,
        size: 0,
      },
      {
        name: ".codex/auth.json",
        typeflag: "0",
        mode: 0o600,
        uid: 1000,
        gid: 1000,
        size: 2,
      },
    ]);
  });

  it("never re-declares a directory an earlier group created (existing dirs get MUTATED by dir entries)", async () => {
    const { backend, calls } = makeArchiveBackend(["/tmp"]);
    await backend.createSandbox({
      ...spec,
      files: [
        { containerPath: "/opt/newdir/a.txt", content: "A" },
        { containerPath: "/opt/newdir/sub/b.txt", content: "B" },
      ],
    });

    const puts = calls.filter((call) => call.method === "PUT" && call.raw);
    expect(puts).toHaveLength(2);
    // Group 2's probe found /opt/newdir (created by group 1's PUT): its
    // archive declares ONLY the still-missing `sub/`, never `newdir/` again.
    const second = parseTarEntries(puts[1]!.raw!);
    expect(second.map((entry) => [entry.name, entry.typeflag])).toEqual([
      ["sub/", "5"],
      ["sub/b.txt", "0"],
    ]);
  });

  it("a vanished container (every probe 404s) stops at / and lets the PUT surface the error", async () => {
    const { backend, calls } = makeArchiveBackend([]);
    // Every HEAD 404s; the PUT to "/" then fails on the real daemon — here it
    // records, which is all the walk-termination pin needs.
    await backend.createSandbox({
      ...spec,
      files: [{ containerPath: "/foo/bar.txt", content: "X" }],
    });
    expect(archiveCalls(calls)).toEqual([
      { method: "HEAD", target: "/foo" },
      { method: "PUT", target: "/" },
    ]);
  });

  it("REFUSES a relative payload path before touching the engine", async () => {
    const { backend, calls } = makeArchiveBackend(["/tmp"]);
    await expect(
      backend.createSandbox({
        ...spec,
        files: [{ containerPath: "etc/passwd", content: "X" }],
      }),
    ).rejects.toThrow(/not an absolute/);
    expect(calls.some((call) => call.path.includes("/archive"))).toBe(false);
  });

  it("REFUSES traversal, durable-home, and system-directory targets", async () => {
    const { backend } = makeArchiveBackend(["/tmp"]);
    await expect(
      backend.createSandbox({
        ...spec,
        files: [{ containerPath: "/tmp/../etc/shadow", content: "X" }],
      }),
    ).rejects.toThrow(/".."/);
    await expect(
      backend.createSandbox({
        ...spec,
        files: [{ containerPath: "/workspace/.home/.bashrc", content: "X" }],
      }),
    ).rejects.toThrow(/durable home/);
    // A control-plane bug must never overwrite the image's own tooling.
    await expect(
      backend.createSandbox({
        ...spec,
        files: [{ containerPath: "/usr/local/bin/node", content: "X" }],
      }),
    ).rejects.toThrow(/system directory/);
  });

  it("strips setuid/setgid/sticky from payload modes — permission bits only", async () => {
    const { backend, calls } = makeArchiveBackend(["/tmp"]);
    await backend.createSandbox({
      ...spec,
      files: [{ containerPath: "/tmp/tool", content: "X", mode: 0o4755 }],
    });
    const put = calls.find((call) => call.method === "PUT" && call.raw);
    expect(parseTarEntries(put!.raw!)[0]).toMatchObject({
      name: "tool",
      mode: 0o755,
    });
  });
});

describe("createSandbox auto-pull", () => {
  /** A transport whose create 404s until the image has been pulled — the
   * clean-host shape. Records the request sequence for the assertions. */
  const pullingTransport = (options: { pullFails?: boolean } = {}) => {
    const calls: string[] = [];
    let pulled = false;
    const transport: EngineTransport = {
      async request({ path }) {
        calls.push(path);
        const body = (statusCode: number, text: string) => ({
          statusCode,
          body: {
            text: async () => text,
            json: async () => JSON.parse(text) as unknown,
            dump: async () => {},
          },
        });
        if (path.includes("/images/create")) {
          pulled = !options.pullFails;
          return body(
            200,
            options.pullFails
              ? '{"status":"Pulling"}\n{"error":"manifest for onecli-agent:test not found"}\n'
              : '{"status":"Pulling"}\n{"status":"Pull complete"}\n',
          );
        }
        if (path.includes("/containers/create") && !pulled) {
          return body(404, '{"message":"No such image: onecli-agent:test"}');
        }
        if (path.includes("/archive")) return body(200, "{}");
        return body(200, '{"Id":"cont-pulled"}');
      },
      close: async () => {},
    };
    return { transport, calls };
  };

  it("pulls the missing image with its exact tag, then retries the create ONCE", async () => {
    const { transport, calls } = pullingTransport();
    const backend = createDockerBackend({
      runnerId: "r-1",
      installationId: "inst-abc",
      network: "onecli-sandboxes",
      networkInternal: true,
      socketPath: "/var/run/docker.sock",
      transport,
    });

    const ref = await backend.createSandbox(spec);

    expect(ref).toBe("cont-pulled");
    const sequence = calls.filter(
      (path) =>
        path.includes("/containers/create") || path.includes("/images/create"),
    );
    expect(sequence).toHaveLength(3);
    expect(sequence[0]).toContain("/containers/create");
    // The tag split is load-bearing: fromImage alone pulls EVERY tag.
    expect(sequence[1]).toContain(
      "/images/create?fromImage=onecli-agent&tag=test",
    );
    expect(sequence[2]).toContain("/containers/create");
  });

  it("a failed pull is the typed refusal, after exactly one attempt", async () => {
    const { transport, calls } = pullingTransport({ pullFails: true });
    const backend = createDockerBackend({
      runnerId: "r-1",
      installationId: "inst-abc",
      network: "onecli-sandboxes",
      networkInternal: true,
      socketPath: "/var/run/docker.sock",
      transport,
    });

    await expect(backend.createSandbox(spec)).rejects.toBeInstanceOf(
      ImageUnavailableError,
    );
    expect(
      calls.filter((path) => path.includes("/images/create")),
    ).toHaveLength(1);
  });

  it("a 404 that is NOT about the image (a missing network) never pulls", async () => {
    const { transport, calls } = pullingTransport();
    const failing: EngineTransport = {
      async request(options) {
        if (options.path.includes("/containers/create")) {
          return {
            statusCode: 404,
            body: {
              text: async () =>
                '{"message":"network onecli-sandboxes not found"}',
              json: async () => ({}),
              dump: async () => {},
            },
          };
        }
        return transport.request(options);
      },
      close: async () => {},
    };
    const backend = createDockerBackend({
      runnerId: "r-1",
      installationId: "inst-abc",
      network: "onecli-sandboxes",
      networkInternal: true,
      socketPath: "/var/run/docker.sock",
      transport: failing,
    });

    await expect(backend.createSandbox(spec)).rejects.toThrow(
      /network onecli-sandboxes not found/,
    );
    expect(calls.filter((path) => path.includes("/images/create"))).toEqual([]);
  });
});

describe("lifecycle calls", () => {
  it("stops gracefully with a timeout, and force-removes", async () => {
    const { backend, calls } = makeBackend({ "/networks?": [] });
    await backend.prepare();
    await backend.stopSandbox("cont-1");
    await backend.removeSandbox("cont-1");

    expect(calls.map((call) => `${call.method} ${call.path}`)).toContain(
      "POST /v1.44/containers/cont-1/stop?t=30",
    );
    expect(calls.map((call) => `${call.method} ${call.path}`)).toContain(
      "DELETE /v1.44/containers/cont-1?force=true",
    );
  });

  it("lists only THIS runner's containers", async () => {
    const { backend, calls } = makeBackend({
      "/networks?": [],
      "/containers/json": [
        {
          Id: "cont-1",
          State: "running",
          Labels: {
            "sh.onecli.sandbox-id": "sb-1",
            "sh.onecli.payload-hash": "hash-1",
          },
        },
        { Id: "cont-unlabeled", State: "running", Labels: {} },
      ],
    });
    await backend.prepare();
    const snapshots = await backend.listSandboxes();

    expect(snapshots).toEqual([
      {
        sandboxId: "sb-1",
        containerRef: "cont-1",
        running: true,
        payloadHash: "hash-1",
      },
    ]);
    const list = calls.find((call) => call.path.includes("/containers/json"));
    expect(list?.path).toContain(
      encodeFilters({ label: ["sh.onecli.runner-id=r-1"] }),
    );
  });

  it("lists homes from labeled volumes", async () => {
    const { backend } = makeBackend({
      "/networks?": [],
      "/volumes?": {
        Volumes: [
          {
            Name: "onecli-home-sb-1",
            Labels: { "sh.onecli.sandbox-id": "sb-1" },
          },
          { Name: "someone-elses-volume", Labels: {} },
        ],
      },
    });
    await backend.prepare();

    expect(await backend.listHomes()).toEqual([
      { sandboxId: "sb-1", ref: "onecli-home-sb-1" },
    ]);
  });

  it("declares itself resident, so park/wake are no-ops", async () => {
    const { backend, calls } = makeBackend({ "/networks?": [] });
    await backend.prepare();
    const before = calls.length;
    await backend.parkHome("onecli-home-sb-1");
    await backend.wakeHome("onecli-home-sb-1");

    expect(backend.homeDurability).toBe("resident");
    expect(calls.length).toBe(before);
  });
});

describe("extra hosts (Linux host-gateway resolution)", () => {
  it("passes ExtraHosts into the container HostConfig when configured", async () => {
    const { backend, calls } = makeBackend(
      { "/networks?": [] },
      { extraHosts: ["host.docker.internal:host-gateway"] },
    );
    await backend.prepare();
    await backend.createSandbox(spec);

    const create = calls.find((call) =>
      call.path.includes("/containers/create"),
    );
    expect(
      (create?.body as { HostConfig?: { ExtraHosts?: string[] } }).HostConfig
        ?.ExtraHosts,
    ).toEqual(["host.docker.internal:host-gateway"]);
  });

  it("omits ExtraHosts entirely by default — no behavior change", async () => {
    const { backend, calls } = makeBackend({ "/networks?": [] });
    await backend.prepare();
    await backend.createSandbox(spec);

    const create = calls.find((call) =>
      call.path.includes("/containers/create"),
    );
    expect(
      Object.keys((create?.body as { HostConfig: object }).HostConfig),
    ).not.toContain("ExtraHosts");
  });
});

describe("listManaged (the orphan sweep's enumeration)", () => {
  it("lists by the managed label — NOT the runner-id filter — and plumbs timestamps", async () => {
    const { backend, calls } = makeBackend({
      "/networks?": [],
      "/containers/json": [
        {
          Id: "cont-foreign",
          Created: 1_700_000_000,
          Labels: {
            "sh.onecli.sandbox-id": "sb-x",
            "sh.onecli.runner-id": "r-dead",
            "sh.onecli.installation": "inst-xyz",
          },
        },
        // Labels missing entirely: identity/age must come back null.
        { Id: "cont-mystery" },
      ],
      "/volumes?": {
        Volumes: [
          {
            Name: "onecli-home-sb-x",
            CreatedAt: "2023-11-14T22:13:20Z",
            Labels: {
              "sh.onecli.sandbox-id": "sb-x",
              "sh.onecli.runner-id": "r-dead",
              "sh.onecli.installation": "inst-xyz",
            },
          },
        ],
      },
    });
    await backend.prepare();
    const managed = await backend.listManaged();

    const managedFilter = encodeFilters({ label: ["sh.onecli.managed=1"] });
    const listCalls = calls.filter(
      (call) =>
        call.path.includes("/containers/json") ||
        call.path.includes("/volumes?"),
    );
    for (const call of listCalls) {
      expect(call.path).toContain(managedFilter);
      expect(call.path).not.toContain(
        encodeURIComponent("sh.onecli.runner-id"),
      );
    }
    // Stopped corpses must be visible: all=true on the container list.
    expect(listCalls.some((call) => call.path.includes("all=true"))).toBe(true);

    expect(managed).toContainEqual({
      kind: "sandbox",
      ref: "cont-foreign",
      sandboxId: "sb-x",
      runnerId: "r-dead",
      installationId: "inst-xyz",
      createdAt: new Date(1_700_000_000 * 1000),
    });
    expect(managed).toContainEqual({
      kind: "sandbox",
      ref: "cont-mystery",
      sandboxId: null,
      runnerId: null,
      installationId: null,
      createdAt: null,
    });
    expect(managed).toContainEqual({
      kind: "home",
      ref: "onecli-home-sb-x",
      sandboxId: "sb-x",
      runnerId: "r-dead",
      installationId: "inst-xyz",
      createdAt: new Date("2023-11-14T22:13:20Z"),
    });
  });

  it("stamps the installation label on containers and volumes", async () => {
    const { backend, calls } = makeBackend({ "/networks?": [] });
    await backend.prepare();
    await backend.provisionHome("sb-1");
    await backend.createSandbox(spec);

    const volume = calls.find((call) => call.path.includes("/volumes/create"));
    expect(
      (volume?.body as { Labels: Record<string, string> }).Labels[
        "sh.onecli.installation"
      ],
    ).toBe("inst-abc");
    const container = calls.find((call) =>
      call.path.includes("/containers/create"),
    );
    expect(
      (container?.body as { Labels: Record<string, string> }).Labels[
        "sh.onecli.installation"
      ],
    ).toBe("inst-abc");
  });
});
