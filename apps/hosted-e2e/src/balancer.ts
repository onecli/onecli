import { connect, createServer, type Socket } from "node:net";
import { request } from "node:http";

/**
 * A tiny TCP load balancer: several runner copies behind ONE address, the
 * multi-replica shape (a layer-4 load balancer in front of the runner
 * copies) on one host. Sandboxes dial the balancer; each new flow goes to
 * one healthy copy and stays there for its life, exactly like a layer-4
 * balancer's flow.
 *
 * Health is probed the way a deployment's load balancer would probe it: a
 * copy is in rotation while its `/healthz` answers 200, so a draining copy
 * (503) or a dead one (refused) stops receiving new flows within one probe.
 * A test can PIN new flows to one copy ("the supervisor lands on B"); the
 * pin is a preference, never a black hole: a pinned copy that is out of
 * rotation is skipped like any other.
 */

export interface TestBalancer {
  /** The one address sandboxes dial (all interfaces). */
  readonly port: number;
  /** Put a copy's listen port in rotation. */
  add(port: number): void;
  /**
   * Take a copy out of rotation for good (its target deregistered), so no
   * new flow reaches it whatever its health says.
   */
  remove(port: number): void;
  /** Prefer this copy for new flows (`undefined`: round robin). */
  pin(port: number | undefined): void;
  close(): Promise<void>;
}

const PROBE_MS = 250;
const PROBE_TIMEOUT_MS = 500;

const healthy = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/healthz",
        timeout: PROBE_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });

export const startTestBalancer = async (): Promise<TestBalancer> => {
  const backends: number[] = [];
  const inRotation = new Set<number>();
  const flows = new Set<Socket>();
  let pinned: number | undefined;
  let next = 0;
  let closed = false;

  const probe = async (): Promise<void> => {
    await Promise.all(
      backends.map(async (port) => {
        if (await healthy(port)) inRotation.add(port);
        else inRotation.delete(port);
      }),
    );
  };
  const prober = setInterval(() => void probe(), PROBE_MS);

  /** Candidates for one new flow, best first. */
  const candidates = (): number[] => {
    const live = backends.filter((port) => inRotation.has(port));
    // Every copy out of rotation: fail OPEN, like a layer-4 balancer,
    // rather than drop every flow on a probe blip.
    const pool = live.length > 0 ? live : [...backends];
    if (pinned !== undefined && pool.includes(pinned)) {
      return [pinned, ...pool.filter((port) => port !== pinned)];
    }
    next = (next + 1) % Math.max(pool.length, 1);
    return [...pool.slice(next), ...pool.slice(0, next)];
  };

  const forward = (client: Socket, ports: number[]): void => {
    const port = ports[0];
    if (port === undefined || client.destroyed) {
      client.destroy();
      return;
    }
    const upstream = connect(port, "127.0.0.1");
    let established = false;
    upstream.once("connect", () => {
      established = true;
      flows.add(upstream);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on("error", () => {
      // Refused before the flow existed: the next copy gets it. After, the
      // flow is simply over (the copy went away mid-flow).
      if (!established) forward(client, ports.slice(1));
      else client.destroy();
    });
    upstream.on("close", () => {
      flows.delete(upstream);
      if (established) client.destroy();
    });
    client.on("close", () => upstream.destroy());
  };

  const server = createServer((client) => {
    client.on("error", () => client.destroy());
    flows.add(client);
    client.on("close", () => flows.delete(client));
    forward(client, candidates());
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("balancer has no port"));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    port,
    add(backend) {
      if (!backends.includes(backend)) backends.push(backend);
      void probe();
    },
    remove(backend) {
      const index = backends.indexOf(backend);
      if (index !== -1) backends.splice(index, 1);
      inRotation.delete(backend);
      if (pinned === backend) pinned = undefined;
    },
    pin(backend) {
      pinned = backend;
    },
    close: () =>
      new Promise((resolve) => {
        if (closed) return resolve();
        closed = true;
        clearInterval(prober);
        for (const flow of flows) flow.destroy();
        server.close(() => resolve());
      }),
  };
};
