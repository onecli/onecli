import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  MAX_RUNNER_EVENTS_PER_POST,
  RUNNER_REPLICA_HEADER,
  runnerChannelClaimRequestSchema,
  runnerEventsRequestSchema,
  runnerRegisterRequestSchema,
  runnerSpawnRequestSchema,
  runnerStrayStopRequestSchema,
  type RunnerEvent,
} from "@onecli/agent-protocol";
import {
  ControlPlaneError,
  createControlPlaneClient,
  isProvablyUnapplied,
} from "./control-plane";

/**
 * The events POST must degrade to MORE requests when a batch outgrows the
 * wire ceiling — never to one 400 that loses the whole report. The batch
 * that makes this real is a reconcile pass over a big fleet: a dead node's
 * worth of corrective `stopped` events lands in a single report() call.
 */
describe("postEvents chunking", () => {
  const event = (n: number): RunnerEvent => ({
    kind: "sandbox.status",
    sandboxId: `sb-${n}`,
    status: "stopped",
  });

  const capturingClient = () => {
    const batches: RunnerEvent[][] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      // Parsed with the REAL wire schema, so an oversized chunk fails here
      // exactly as the control plane would fail it.
      const body = runnerEventsRequestSchema.parse(
        JSON.parse(String(init?.body)),
      );
      batches.push(body.events);
      return new Response(null, { status: 204 });
    };
    const client = createControlPlaneClient({
      baseUrl: "http://control-plane",
      token: "rnr_test",
      fetchImpl,
    });
    return { client, batches };
  };

  it("slices an oversized batch at the ceiling, preserving order", async () => {
    const { client, batches } = capturingClient();
    const events = Array.from(
      { length: MAX_RUNNER_EVENTS_PER_POST + 50 },
      (_, n) => event(n),
    );

    await client.postEvents(events);

    expect(batches.map((batch) => batch.length)).toEqual([
      MAX_RUNNER_EVENTS_PER_POST,
      50,
    ]);
    // Order is what the report chain depends on: flat again, it is the
    // exact input sequence.
    expect(batches.flat()).toEqual(events);
  });

  it("posts nothing for an empty batch (the wire refuses empty events)", async () => {
    const { client, batches } = capturingClient();

    await client.postEvents([]);

    expect(batches).toEqual([]);
  });

  it("posts chunks strictly in sequence — the next waits for the previous", async () => {
    // The server applies events one at a time in arrival order, and
    // order-sensitive traffic rides this path (turn.finished paired with a
    // corrective sandbox.status). MUTATION-PROOF: firing the chunks
    // concurrently (Promise.all over the slices) fails the first expect.
    const sizes: number[] = [];
    let releaseFirst = (): void => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = runnerEventsRequestSchema.parse(
        JSON.parse(String(init?.body)),
      );
      sizes.push(body.events.length);
      if (sizes.length === 1) await firstHeld;
      return new Response(null, { status: 204 });
    };
    const client = createControlPlaneClient({
      baseUrl: "http://control-plane",
      token: "rnr_test",
      fetchImpl,
    });

    const posting = client.postEvents(
      Array.from({ length: MAX_RUNNER_EVENTS_PER_POST + 50 }, (_, n) =>
        event(n),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sizes).toEqual([MAX_RUNNER_EVENTS_PER_POST]);

    releaseFirst();
    await posting;
    expect(sizes).toEqual([MAX_RUNNER_EVENTS_PER_POST, 50]);
  });
});

/**
 * The retry law (control-plane.ts): retried statuses are ONLY the ones where
 * the server provably did not apply the batch AND a retry can plausibly
 * succeed — a 429 throttle can clear, the events route answers 500 only when
 * zero events applied, a 503 deploy window passes. Everything else stays
 * drop-with-warn: timeouts/network/502/504 may have landed (a re-post could
 * duplicate transcript rows — `seq` is assigned server-side at arrival), and
 * a 403 is a WAF verdict that identical bytes cannot outwait (a content match
 * is deterministic; a rate block outlasts the budget and feeds on retries).
 */
describe("postEvents retry law", () => {
  const event = (n: number): RunnerEvent => ({
    kind: "sandbox.status",
    sandboxId: `sb-${n}`,
    status: "stopped",
  });

  /** Answers one scripted status (or rejection) per call; 204 when exhausted. */
  const scriptedClient = (answers: Array<number | "reject">) => {
    const calls: RunnerEvent[][] = [];
    const sleeps: number[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = runnerEventsRequestSchema.parse(
        JSON.parse(String(init?.body)),
      );
      calls.push(body.events);
      const answer = answers.shift() ?? 204;
      if (answer === "reject") throw new TypeError("fetch failed");
      return answer === 204
        ? new Response(null, { status: 204 })
        : new Response("{}", { status: answer });
    };
    const client = createControlPlaneClient({
      baseUrl: "http://control-plane",
      token: "rnr_test",
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });
    return { client, calls, sleeps };
  };

  it.each([429, 500, 503])(
    "retries a %i (provably never applied, plausibly clearing) and succeeds",
    async (status) => {
      const { client, calls, sleeps } = scriptedClient([status]);
      await client.postEvents([event(1)]);
      expect(calls).toHaveLength(2);
      expect(sleeps).toEqual([1_000]);
    },
  );

  it("gives up after the attempt budget and rethrows for the caller's warn", async () => {
    const { client, calls, sleeps } = scriptedClient([503, 503, 503, 503]);
    await expect(client.postEvents([event(1)])).rejects.toBeInstanceOf(
      ControlPlaneError,
    );
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([1_000, 4_000, 10_000]);
  });

  it.each([400, 401, 403, 502, 504])(
    "never retries a %i — durable refusals, WAF verdicts, and may-have-landed answers alike",
    async (status) => {
      const { client, calls, sleeps } = scriptedClient([status]);
      await expect(client.postEvents([event(1)])).rejects.toBeInstanceOf(
        ControlPlaneError,
      );
      expect(calls).toHaveLength(1);
      expect(sleeps).toEqual([]);
    },
  );

  it("never retries a transport failure (the batch may have landed)", async () => {
    const { client, calls, sleeps } = scriptedClient(["reject"]);
    await expect(client.postEvents([event(1)])).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("retries a REFUSED connection (nothing was sent) through a real restart window", async () => {
    // Real sockets, not a scripted rejection: the control plane is down for
    // the first attempts (connection refused), then comes back. MUTATION-
    // PROOF: without the never-sent arm the first refusal is thrown and the
    // batch (in production: a turn.finished) is lost.
    let hits = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        hits += 1;
        res.statusCode = 204;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a TCP address");
    }
    const { port } = address;
    await new Promise<void>((r) => server.close(() => r()));

    const sleeps: number[] = [];
    const client = createControlPlaneClient({
      baseUrl: `http://127.0.0.1:${String(port)}`,
      token: "rnr_test",
      sleepImpl: async (ms) => {
        sleeps.push(ms);
        // The api-server comes back during the second backoff.
        if (sleeps.length === 2) {
          await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
        }
      },
    });
    try {
      await client.postEvents([event(1)]);
      expect(hits).toBe(1);
      expect(sleeps).toEqual([1_000, 4_000]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("a mid-run retry re-posts the SAME chunk in place, then moves on", async () => {
    const { client, calls } = scriptedClient([204, 500]);
    const events = Array.from(
      { length: MAX_RUNNER_EVENTS_PER_POST + 50 },
      (_, n) => event(n),
    );
    await client.postEvents(events);
    expect(calls.map((batch) => batch.length)).toEqual([
      MAX_RUNNER_EVENTS_PER_POST,
      50,
      50,
    ]);
    // The retried chunk is identical to its failed attempt — a re-post,
    // never a re-slice, so arrival order (which decides `seq`) holds.
    expect(calls[2]).toEqual(calls[1]);
  });
});

/**
 * The "provably unapplied" verdict, over the error shapes fetch really
 * throws: a `TypeError("fetch failed")` whose `cause` is the socket error, or,
 * when the host resolved to several addresses, an AggregateError over one
 * error per attempt whose own `code` copies the FIRST attempt's.
 */
describe("isProvablyUnapplied", () => {
  const socketError = (code: string): Error =>
    Object.assign(new Error(code), { code });
  const fetchFailed = (cause: unknown): TypeError =>
    new TypeError("fetch failed", { cause });
  /** Node's dual-stack shape: the aggregate carries the first attempt's code. */
  const dualStack = (...codes: string[]): AggregateError =>
    Object.assign(new AggregateError(codes.map(socketError)), {
      code: codes[0],
    });

  it.each(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"])(
    "a request that never left (%s) is unapplied",
    (code) => {
      expect(isProvablyUnapplied(fetchFailed(socketError(code)))).toBe(true);
    },
  );

  it("every dual-stack attempt refused is unapplied", () => {
    expect(
      isProvablyUnapplied(
        fetchFailed(dualStack("ECONNREFUSED", "ECONNREFUSED")),
      ),
    ).toBe(true);
  });

  it("one dual-stack attempt that may have connected makes the whole failure ambiguous", () => {
    // MUTATION-PROOF: reading the aggregate's own code (the first attempt's)
    // instead of every attempt answers true here, and a request that may
    // have landed is re-sent.
    expect(
      isProvablyUnapplied(fetchFailed(dualStack("ECONNREFUSED", "ETIMEDOUT"))),
    ).toBe(false);
  });

  it.each(["ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET", "EPIPE"])(
    "a failure that may have landed (%s) is not",
    (code) => {
      expect(isProvablyUnapplied(fetchFailed(socketError(code)))).toBe(false);
    },
  );

  it("a timeout (no socket cause at all) is not", () => {
    expect(
      isProvablyUnapplied(new DOMException("aborted", "TimeoutError")),
    ).toBe(false);
    expect(isProvablyUnapplied(fetchFailed(undefined))).toBe(false);
    expect(isProvablyUnapplied(null)).toBe(false);
  });

  it("follows the status law: 429/500/503 unapplied, everything else not", () => {
    for (const status of [429, 500, 503]) {
      expect(isProvablyUnapplied(new ControlPlaneError(status, "x"))).toBe(
        true,
      );
    }
    for (const status of [400, 401, 403, 404, 502, 504]) {
      expect(isProvablyUnapplied(new ControlPlaneError(status, "x"))).toBe(
        false,
      );
    }
  });

  it("agrees with what fetch really throws for a closed port", async () => {
    // The shape check above is only as good as its fixtures: pin it to the
    // runtime's own error once.
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a TCP address");
    }
    await new Promise<void>((r) => server.close(() => r()));
    const thrown = await fetch(`http://127.0.0.1:${String(address.port)}/`, {
      method: "POST",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(isProvablyUnapplied(thrown)).toBe(true);
  });
});

describe("uploadAttachment (the raw-body POST)", () => {
  /**
   * Against a REAL node:http server through the REAL global fetch — a stub
   * cannot see what the wire carries. The hosted e2e caught a caller-set
   * `content-length` colliding with the one fetch derives (undici's
   * `invalid content-length header` → `fetch failed`) while every fetch-
   * stubbed test stayed green; this pins the wire shape instead.
   */
  const startServer = async () => {
    const { createServer } = await import("node:http");
    const seen: {
      headers: Record<string, string | string[] | undefined>;
      bytes: Buffer;
    }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ headers: req.headers, bytes: Buffer.concat(chunks) });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, attachmentId: "att-1" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as { port: number };
    return {
      url: `http://127.0.0.1:${port}`,
      seen,
      close: () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
    };
  };

  it("POSTs the exact bytes with the self-describing headers; fetch owns content-length", async () => {
    const server = await startServer();
    try {
      const client = createControlPlaneClient({
        baseUrl: server.url,
        token: "rnr_t",
      });
      const bytes = Buffer.alloc(300_000, 7);
      const result = await client.uploadAttachment("sb-1", {
        conversationId: "cv-1",
        turnId: "t-1",
        name: "clip <1>.webm",
        mimeType: "video/webm",
        sha256: "a".repeat(64),
        caption: "the run",
        bytes,
      });
      expect(result).toEqual({ ok: true, attachmentId: "att-1" });
      const [req] = server.seen;
      expect(req).toBeDefined();
      expect(Buffer.compare(req!.bytes, bytes)).toBe(0);
      expect(req!.headers["content-length"]).toBe(String(bytes.byteLength));
      expect(req!.headers["content-type"]).toBe("video/webm");
      expect(req!.headers.authorization).toBe("Bearer rnr_t");
      expect(req!.headers["x-onecli-sandbox-id"]).toBe("sb-1");
      expect(req!.headers["x-onecli-conversation-id"]).toBe("cv-1");
      expect(req!.headers["x-onecli-turn-id"]).toBe("t-1");
      // Human strings percent-encoded: header values are Latin-1.
      expect(req!.headers["x-onecli-file-name"]).toBe(
        encodeURIComponent("clip <1>.webm"),
      );
      expect(req!.headers["x-onecli-file-caption"]).toBe(
        encodeURIComponent("the run"),
      );
      expect(req!.headers["x-onecli-file-sha256"]).toBe("a".repeat(64));
    } finally {
      await server.close();
    }
  });
});

/**
 * The copy surface: a runner built to run as several copies registers its
 * copy, then names it on EVERY call (that is what keeps its liveness fresh and
 * what the control plane fences channel-bound work by). Every body is parsed
 * with the REAL wire schema, so a client drift fails here exactly as the
 * control plane would refuse it.
 */
describe("the runner copy surface", () => {
  const TOKEN_HASH = "b".repeat(64);

  type Seen = {
    method: string;
    path: string;
    replica: string | null;
    body: unknown;
  };

  const copyClient = (
    answer: (seen: Seen) => Response = () =>
      new Response(null, { status: 204 }),
  ) => {
    const seen: Seen[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const entry: Seen = {
        method: init?.method ?? "GET",
        path: url.pathname,
        replica: new Headers(init?.headers).get(RUNNER_REPLICA_HEADER),
        body:
          init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      seen.push(entry);
      if (entry.path === "/v1/runner/register") {
        return Response.json({ runnerId: "r-1", replicaId: "copy-1" });
      }
      return answer(entry);
    };
    const client = createControlPlaneClient({
      baseUrl: "http://control-plane",
      token: "rnr_test",
      fetchImpl,
    });
    return { client, seen };
  };

  const capabilities = {
    maxSandboxes: 4,
    backend: "fake",
    homeDurability: "resident" as const,
  };
  const registration = {
    name: "runner",
    capabilities,
    replicaName: "pod-a",
    portApiUrl: "http://10.0.4.17:8485",
  };

  it("registers its copy and names it on every later call, binary ones included", async () => {
    const { client, seen } = copyClient((entry) =>
      entry.path.startsWith("/v1/runner/attachments/")
        ? new Response(new Uint8Array([1]))
        : new Response(null, { status: 204 }),
    );

    expect(await client.register(registration)).toEqual({
      runnerId: "r-1",
      replicaId: "copy-1",
    });
    expect(runnerRegisterRequestSchema.parse(seen[0]!.body)).toEqual({
      name: "runner",
      capabilities,
      replicaName: "pod-a",
      portApiUrl: "http://10.0.4.17:8485",
    });
    // Registration itself carries no copy: it is what mints one.
    expect(seen[0]!.replica).toBeNull();

    await client.heartbeat();
    await client.fetchAttachment("att-1");
    expect(seen.slice(1).map((entry) => entry.replica)).toEqual([
      "copy-1",
      "copy-1",
    ]);
  });

  it("refuses a control plane too old to answer a copy id, loudly", async () => {
    const fetchImpl: typeof fetch = async () =>
      Response.json({ runnerId: "r-1" });
    const client = createControlPlaneClient({
      baseUrl: "http://control-plane",
      token: "rnr_test",
      fetchImpl,
    });
    await expect(client.register(registration)).rejects.toThrow(
      /control plane is too old/,
    );
  });

  it("records a spawn: true when applied, false when the start moved on", async () => {
    let status = 204;
    const { client, seen } = copyClient(() => new Response(null, { status }));
    await client.register(registration);

    expect(
      await client.recordSpawn("sb/1", {
        containerRef: "ctr-1",
        tokenHash: TOKEN_HASH,
      }),
    ).toBe(true);
    const put = seen.at(-1)!;
    expect(put.method).toBe("PUT");
    expect(put.path).toBe("/v1/runner/sandboxes/sb%2F1/spawn");
    expect(runnerSpawnRequestSchema.parse(put.body)).toEqual({
      containerRef: "ctr-1",
      tokenHash: TOKEN_HASH,
    });

    status = 409;
    expect(
      await client.recordSpawn("sb-1", {
        containerRef: "ctr-1",
        tokenHash: TOKEN_HASH,
      }),
    ).toBe(false);

    // Anything else is not an answer about the spawn: the caller decides.
    status = 500;
    await expect(
      client.recordSpawn("sb-1", {
        containerRef: "ctr-1",
        tokenHash: TOKEN_HASH,
      }),
    ).rejects.toBeInstanceOf(ControlPlaneError);
  });

  it("claims a channel through either door; a refusal is null, a failure throws", async () => {
    let answer: () => Response = () =>
      Response.json({ sandboxId: "sb-1", containerRef: "ctr-1" });
    const { client, seen } = copyClient(() => answer());
    await client.register(registration);

    const token = {
      door: "token" as const,
      connectionId: "conn-1",
      connectedAt: 1_000,
      tokenHash: TOKEN_HASH,
    };
    expect(await client.claimChannel(token)).toEqual({
      sandboxId: "sb-1",
      containerRef: "ctr-1",
    });
    expect(seen.at(-1)!.path).toBe("/v1/runner/channels");
    expect(runnerChannelClaimRequestSchema.parse(seen.at(-1)!.body)).toEqual(
      token,
    );

    answer = () => Response.json({ error: "Not found" }, { status: 404 });
    expect(
      await client.claimChannel({
        door: "session",
        connectionId: "conn-2",
        connectedAt: 2_000,
        sandboxId: "sb-1",
        containerRef: "ctr-1",
      }),
    ).toBeNull();

    answer = () => new Response(null, { status: 503 });
    await expect(client.claimChannel(token)).rejects.toBeInstanceOf(
      ControlPlaneError,
    );

    // A wrong-shaped 200 must never read as a claim.
    answer = () => Response.json({ sandboxId: "sb-1" });
    await expect(client.claimChannel(token)).rejects.toThrow();
  });

  it("releases a channel, claims a stray stop, and retires the copy", async () => {
    let status = 204;
    const { client, seen } = copyClient(() => new Response(null, { status }));
    await client.register(registration);

    await client.releaseChannel("conn/1");
    expect(seen.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/v1/runner/channels/conn%2F1",
      replica: "copy-1",
    });

    expect(await client.claimStrayStop("sb-1", "ctr-1")).toBe(true);
    expect(seen.at(-1)!.path).toBe("/v1/runner/sandboxes/sb-1/stray-stop");
    expect(runnerStrayStopRequestSchema.parse(seen.at(-1)!.body)).toEqual({
      containerRef: "ctr-1",
    });
    status = 409;
    expect(await client.claimStrayStop("sb-1", "ctr-1")).toBe(false);

    status = 204;
    await client.retire();
    expect(seen.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/v1/runner/replicas/self",
      replica: "copy-1",
    });
  });

  it("reads its reconciler role alone, and tells an api too old to answer it from a failure", async () => {
    // MUTATION-PROOF: read a 404 as `false` (an old api would leave no copy
    // reconciling) or swallow a 5xx as `undefined` (an outage would quietly
    // fall through to the full listing on every copy).
    let answer = (): Response => Response.json({ reconciler: true });
    const { client, seen } = copyClient(() => answer());
    await client.register(registration);

    expect(await client.isReconciler()).toBe(true);
    expect(seen.at(-1)).toMatchObject({
      method: "GET",
      path: "/v1/runner/replicas/self",
      replica: "copy-1",
    });
    answer = () => Response.json({ reconciler: false });
    expect(await client.isReconciler()).toBe(false);

    answer = () => Response.json({ error: "Not found" }, { status: 404 });
    expect(await client.isReconciler()).toBeUndefined();

    answer = () => new Response(null, { status: 503 });
    await expect(client.isReconciler()).rejects.toThrow(/503/);

    answer = () => Response.json({ reconciler: "yes" });
    await expect(client.isReconciler()).rejects.toThrow();
  });
});
