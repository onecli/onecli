import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ResolverRefusedError,
  ResolverUnreachableError,
  type Resolver,
  type ResolverAnswer,
} from "./backend/types";
import {
  ControlPlaneUnreachableError,
  type ControlPlaneClient,
  type HeartbeatAnswer,
  type OpenedSession,
} from "./control-plane-client";
import { createFakeTerminatorMetrics } from "./metrics";
import {
  CLOSE_CONTROL_PLANE_UNREACHABLE,
  CLOSE_IDLE_TIMEOUT,
  CLOSE_MAX_SESSION,
  WakeTimeoutError,
  createConnectionSession,
  type ConnectionSessionDeps,
} from "./session";

const POLICY = {
  maxSessionSeconds: 100,
  idleTimeoutSeconds: 50,
  heartbeatSeconds: 5,
};

/** Headroom past a policy boundary for the 1s policy tick to observe it. */
const POLICY_SLACK_MS = 2_000;

interface FakeControlPlane extends ControlPlaneClient {
  opens: Array<{ certificate: string; sourceIp: string }>;
  heartbeats: boolean[];
  closes: Array<{ sessionId: string; reason: string }>;
  openBehavior: () => Promise<OpenedSession>;
  heartbeatBehavior: () => Promise<HeartbeatAnswer>;
}

const makeControlPlane = (): FakeControlPlane => {
  const fake: FakeControlPlane = {
    opens: [],
    heartbeats: [],
    closes: [],
    openBehavior: () =>
      Promise.resolve({
        sessionId: "sess-1",
        grant: "grant-1",
        policy: POLICY,
      }),
    heartbeatBehavior: () => Promise.resolve({ revoked: false }),
    openSession(input) {
      fake.opens.push(input);
      return fake.openBehavior();
    },
    heartbeat(_sessionId, attached) {
      fake.heartbeats.push(attached);
      return fake.heartbeatBehavior();
    },
    close(sessionId, reason) {
      fake.closes.push({ sessionId, reason });
      return Promise.resolve();
    },
  };
  return fake;
};

/** The fake substrate's own target vocabulary — the session must thread it
 * opaquely, which is exactly what these tests now prove. */
interface TestTarget {
  namespace: string;
  pod: string;
  container: string;
  token: string;
  server: string;
  caFile: string;
}

const testTarget = (): TestTarget => ({
  namespace: "ws-1",
  pod: "pod-1",
  container: "sandbox",
  token: "tok-1",
  server: "https://kube.test:443",
  caFile: "/tmp/ca.crt",
});

const readyAnswer = () => ({
  status: "ready" as const,
  target: testTarget(),
  expiresAt: new Date(Date.now() + 600_000),
});

interface FakeResolver extends Resolver<TestTarget> {
  opens: Array<{ certificate: string; grant: string }>;
  deletes: string[];
  openBehavior: (attempt: number) => Promise<ResolverAnswer<TestTarget>>;
}

const makeResolver = (): FakeResolver => {
  const fake: FakeResolver = {
    opens: [],
    deletes: [],
    openBehavior: () => Promise.resolve(readyAnswer()),
    open(input) {
      fake.opens.push(input);
      return fake.openBehavior(fake.opens.length);
    },
    close(sessionId) {
      fake.deletes.push(sessionId);
      return Promise.resolve();
    },
  };
  return fake;
};

const makeChannel = (options?: { neverFlushes?: boolean }) => {
  const channel = {
    writes: [] as string[],
    ended: false,
    // Reports the write flushed, like ssh2's Duplex does. `neverFlushes`
    // models a wedged peer: the close must still complete on its own bound.
    write(data: string, flushed?: () => void) {
      channel.writes.push(data);
      if (!options?.neverFlushes) flushed?.();
      return true;
    },
    end() {
      channel.ended = true;
    },
  };
  return channel;
};

const harness = (over: Partial<ConnectionSessionDeps<TestTarget>> = {}) => {
  const controlPlane = makeControlPlane();
  const resolver = makeResolver();
  const metrics = createFakeTerminatorMetrics();
  let connectionEnded = 0;
  const session = createConnectionSession(
    {
      controlPlane,
      resolver,
      metrics,
      wakeWaitSeconds: 60,
      wakePollMs: 5,
      now: () => Date.now(),
      ...over,
    },
    {
      certificate: "ssh-ed25519-cert-v01@openssh.com AAAA",
      sourceIp: "203.0.113.7",
      agentId: "agent-1",
      endConnection: () => {
        connectionEnded += 1;
      },
    },
  );
  return {
    controlPlane,
    resolver,
    metrics,
    session,
    connectionEnded: () => connectionEnded,
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("createConnectionSession — open/close contract", () => {
  it("opens once per connection and emits SshSessionsOpened", async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.session.open(), h.session.open()]);
    expect(a.sessionId).toBe("sess-1");
    expect(b).toBe(a);
    expect(h.controlPlane.opens).toHaveLength(1);
    expect(h.controlPlane.opens[0]?.sourceIp).toBe("203.0.113.7");
    expect(h.metrics.counts.opened).toBe(1);
  });

  it("reports close exactly once — the first reason wins", async () => {
    const h = harness();
    await h.session.open();
    await h.session.close("idle_timeout");
    await h.session.close("revoked");
    expect(h.controlPlane.closes).toEqual([
      { sessionId: "sess-1", reason: "idle_timeout" },
    ]);
    expect(h.resolver.deletes).toEqual(["sess-1"]);
    expect(h.metrics.counts.closed).toBe(1);
    expect(h.connectionEnded()).toBeGreaterThan(0);
  });

  it("close banners PTY channels only, and ends every channel", async () => {
    const h = harness();
    await h.session.open();
    const pty = makeChannel();
    const plain = makeChannel();
    h.session.registerChannel(pty, true);
    h.session.registerChannel(plain, false);
    await h.session.close("revoked", "your access was revoked");
    expect(pty.writes.join("")).toContain("your access was revoked");
    expect(plain.writes).toHaveLength(0);
    expect(pty.ended).toBe(true);
    expect(plain.ended).toBe(true);
  });

  // The reason is only useful if it LEAVES. Severing the transport in the same
  // tick as the banner loses it: OpenSSH takes the DISCONNECT out of the same
  // read batch and exits without flushing (measured on the dev live gate — a
  // terminator pod delete dropped a live PTY session with a bare
  // "Received disconnect … :11:" instead of the shutdown banner).
  it("holds the connection open until the banner has flushed", async () => {
    const h = harness();
    await h.session.open();
    let flush: () => void = () => undefined;
    const pty = {
      writes: [] as string[],
      ended: false,
      write(data: string, flushed?: () => void) {
        pty.writes.push(data);
        flush = flushed ?? (() => undefined);
        return true;
      },
      end() {
        pty.ended = true;
      },
    };
    h.session.registerChannel(pty, true);
    const closing = h.session.close("revoked", "your access was revoked");
    // The banner is written synchronously; the transport must still be up.
    expect(pty.writes.join("")).toContain("your access was revoked");
    await Promise.resolve();
    expect(h.connectionEnded()).toBe(0);
    flush();
    await closing;
    expect(h.connectionEnded()).toBeGreaterThan(0);
  });

  it("severs a wedged peer on the drain bound rather than hanging", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.session.open();
    const pty = makeChannel({ neverFlushes: true });
    h.session.registerChannel(pty, true);
    const closing = h.session.close("revoked", "your access was revoked");
    await Promise.resolve();
    expect(h.connectionEnded()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_500);
    await closing;
    expect(h.connectionEnded()).toBeGreaterThan(0);
  });

  // The flush alone is a WEAK barrier: it proves the banner reached OUR
  // socket, not the client. Severing right after it races the DISCONNECT
  // into the client's same read batch on a loaded host and the banner is
  // lost (the e2e control-plane-unreachable flake). A channel that can
  // report its close ack holds the sever until the ack arrives.
  it("holds the sever until the client acks the channel close", async () => {
    const h = harness();
    await h.session.open();
    let ack: () => void = () => undefined;
    const pty = {
      writes: [] as string[],
      ended: false,
      write(data: string, flushed?: () => void) {
        pty.writes.push(data);
        flushed?.();
        return true;
      },
      end() {
        pty.ended = true;
      },
      once(_event: "close", listener: () => void) {
        ack = listener;
      },
    };
    h.session.registerChannel(pty, true);
    const closing = h.session.close("revoked", "your access was revoked");
    // Flushed, ended — but not acked: the transport must still be up. A full
    // macrotask (not just microtasks) so the pre-fix flush-only sever would
    // be observed here — this assertion FAILS against the old close path.
    expect(pty.ended).toBe(true);
    await new Promise((done) => setTimeout(done, 20));
    expect(h.connectionEnded()).toBe(0);
    ack();
    await closing;
    expect(h.connectionEnded()).toBeGreaterThan(0);
  });

  // A client that never acks (wedged, gone mid-write) cannot pin the
  // socket: the ack barrier has the same bound as the flush.
  it("severs on the drain bound when the close ack never arrives", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.session.open();
    const pty = {
      writes: [] as string[],
      ended: false,
      write(data: string, flushed?: () => void) {
        pty.writes.push(data);
        flushed?.();
        return true;
      },
      end() {
        pty.ended = true;
      },
      once() {
        // Never acks.
      },
    };
    h.session.registerChannel(pty, true);
    const closing = h.session.close("revoked", "your access was revoked");
    await Promise.resolve();
    expect(h.connectionEnded()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_500);
    await closing;
    expect(h.connectionEnded()).toBeGreaterThan(0);
  });

  it("a close racing an in-flight open still reports once the row exists", async () => {
    const h = harness();
    let release: () => void = () => undefined;
    h.controlPlane.openBehavior = () =>
      new Promise((resolve) => {
        release = () =>
          resolve({ sessionId: "sess-9", grant: "g", policy: POLICY });
      });
    const opening = h.session.open();
    const closing = h.session.close("client_disconnect");
    release();
    await opening;
    await closing;
    expect(h.controlPlane.closes).toEqual([
      { sessionId: "sess-9", reason: "client_disconnect" },
    ]);
    expect(h.resolver.deletes).toEqual(["sess-9"]);
  });

  it("a refused open reports nothing (no session ever existed)", async () => {
    const h = harness();
    h.controlPlane.openBehavior = () =>
      Promise.reject(new Error("access denied"));
    await expect(h.session.open()).rejects.toThrow("access denied");
    await h.session.close("client_disconnect");
    expect(h.controlPlane.closes).toHaveLength(0);
    expect(h.metrics.counts.closed).toBe(0);
  });
});

describe("createConnectionSession — heartbeat loop", () => {
  it("closes with the control plane's reason on revocation, bannering PTYs", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.session.open();
    const channel = makeChannel();
    h.session.registerChannel(channel, true);
    h.controlPlane.heartbeatBehavior = () =>
      Promise.resolve({ revoked: true, reason: "workspace_access_revoked" });
    await vi.advanceTimersByTimeAsync(POLICY.heartbeatSeconds * 1000 + 10);
    expect(h.controlPlane.closes).toEqual([
      { sessionId: "sess-1", reason: "workspace_access_revoked" },
    ]);
    expect(channel.writes.join("")).toContain("your access was revoked");
  });

  it("fails closed after three consecutive transport failures", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.session.open();
    h.controlPlane.heartbeatBehavior = () =>
      Promise.reject(new ControlPlaneUnreachableError("down"));
    await vi.advanceTimersByTimeAsync(2 * POLICY.heartbeatSeconds * 1000 + 10);
    expect(h.controlPlane.closes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(POLICY.heartbeatSeconds * 1000);
    expect(h.controlPlane.closes).toEqual([
      { sessionId: "sess-1", reason: CLOSE_CONTROL_PLANE_UNREACHABLE },
    ]);
  });

  it("a successful heartbeat resets the strike count", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.session.open();
    let fail = true;
    h.controlPlane.heartbeatBehavior = () =>
      fail
        ? Promise.reject(new ControlPlaneUnreachableError("down"))
        : Promise.resolve({ revoked: false });
    await vi.advanceTimersByTimeAsync(2 * POLICY.heartbeatSeconds * 1000 + 10);
    fail = false;
    await vi.advanceTimersByTimeAsync(POLICY.heartbeatSeconds * 1000);
    fail = true;
    await vi.advanceTimersByTimeAsync(2 * POLICY.heartbeatSeconds * 1000);
    expect(h.controlPlane.closes).toHaveLength(0);
  });

  it("markAttached fires an immediate attached heartbeat", async () => {
    const h = harness();
    await h.session.open();
    h.session.markAttached();
    await vi.waitFor(() => expect(h.controlPlane.heartbeats).toContain(true));
  });
});

describe("createConnectionSession — local policy", () => {
  it("closes at max session duration regardless of activity", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.session.open();
    for (let i = 0; i < POLICY.maxSessionSeconds; i += 10) {
      await vi.advanceTimersByTimeAsync(10_000);
      h.session.touch();
    }
    await vi.advanceTimersByTimeAsync(POLICY_SLACK_MS);
    const reasons = h.controlPlane.closes.map((c) => c.reason);
    expect(reasons).toEqual([CLOSE_MAX_SESSION]);
  });

  it("closes on idle timeout, and touch() defers it", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.session.open();
    await vi.advanceTimersByTimeAsync(30_000);
    h.session.touch();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.controlPlane.closes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(
      POLICY.idleTimeoutSeconds * 1000 + POLICY_SLACK_MS,
    );
    expect(h.controlPlane.closes.map((c) => c.reason)).toEqual([
      CLOSE_IDLE_TIMEOUT,
    ]);
  });
});

describe("createConnectionSession — wake wait", () => {
  it("polls the resolver through waking to ready and records the wake wait", async () => {
    const h = harness();
    h.resolver.openBehavior = (attempt) =>
      Promise.resolve(attempt < 3 ? { status: "waking" } : readyAnswer());
    const lines: string[] = [];
    const target = await h.session.ensureTarget((line) => lines.push(line));
    // The resolver's target round-trips untouched — the session never
    // interprets it (the real merge coverage lives in the kube resolver's
    // own wire test).
    expect(target).toEqual(testTarget());
    expect(h.resolver.opens.length).toBeGreaterThanOrEqual(3);
    expect(h.resolver.opens[0]?.grant).toBe("grant-1");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toContain("waking");
    expect(h.metrics.wakeWaits).toHaveLength(1);
  });

  it("reuses a fresh resolved target without re-polling", async () => {
    const h = harness();
    await h.session.ensureTarget(() => undefined);
    const resolverCalls = h.resolver.opens.length;
    await h.session.ensureTarget(() => undefined);
    expect(h.resolver.opens.length).toBe(resolverCalls);
  });

  it("re-resolves when the cached target is near expiry", async () => {
    const h = harness();
    h.resolver.openBehavior = () =>
      Promise.resolve({
        ...readyAnswer(),
        expiresAt: new Date(Date.now() + 1_000),
      });
    await h.session.ensureTarget(() => undefined);
    const resolverCalls = h.resolver.opens.length;
    await h.session.ensureTarget(() => undefined);
    expect(h.resolver.opens.length).toBeGreaterThan(resolverCalls);
  });

  it("times out honestly when the sandbox never wakes", async () => {
    const h = harness({ wakeWaitSeconds: 0.05 });
    h.resolver.openBehavior = () => Promise.resolve({ status: "waking" });
    await expect(h.session.ensureTarget(() => undefined)).rejects.toThrow(
      WakeTimeoutError,
    );
  });

  it("propagates deterministic resolver refusals immediately", async () => {
    const h = harness();
    h.resolver.openBehavior = () =>
      Promise.reject(new ResolverRefusedError("grant_refused", "no"));
    await expect(h.session.ensureTarget(() => undefined)).rejects.toThrow(
      ResolverRefusedError,
    );
    expect(h.resolver.opens).toHaveLength(1);
  });

  it("rides out transient resolver unreachability inside the window", async () => {
    const h = harness();
    h.resolver.openBehavior = (attempt) =>
      attempt === 1
        ? Promise.reject(new ResolverUnreachableError("blip"))
        : Promise.resolve(readyAnswer());
    const target = await h.session.ensureTarget(() => undefined);
    expect(target.pod).toBe("pod-1");
  });
});
