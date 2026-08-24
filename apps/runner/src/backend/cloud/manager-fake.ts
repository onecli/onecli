import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A hand-rolled, HTTP-level sandbox-manager fake for the cloud backend's
 * conformance suite. Deliberately NOT an import of apps/sandbox-manager:
 * that app is cloud-only while this runner syncs to the OSS mirror, so any
 * import would break the mirror's build — and an HTTP fake also exercises
 * the real manager-client (fetch, auth header, envelope decoding), which an
 * injected client object would bypass.
 *
 * Behavior is the manager's documented contract: pod-UID refs, tolerant
 * stops, owner-scoped snapshots, poll-driven park/wake. Tests script the
 * interesting states directly on the exposed maps/queues.
 */

export interface FakeSnapshot {
  sandboxId: string;
  runnerId: string;
  containerRef: string;
  running: boolean;
  payloadHash: string | null;
  phase: string | null;
  waitingReason: string | null;
}

export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

export interface FakeManager {
  url: string;
  requests: RecordedRequest[];
  /** containerRef → snapshot; mutate to script pod states. */
  sandboxes: Map<string, FakeSnapshot>;
  /** sandboxId → runnerId owner (the PVC-ish home list). */
  homes: Map<string, string>;
  /** Managed objects answered verbatim by GET /v1/managed. */
  managed: unknown[];
  /** Park/wake answers, shifted per call; the LAST entry repeats forever. */
  parkStatuses: string[];
  wakeStatuses: string[];
  /** When set, the next create answers this instead of succeeding. */
  nextCreateError: { status: number; code: string; message: string } | null;
  /** When set, the next create answers 201 with THIS body — a version-skewed
   * manager whose 2xx shape the client must refuse fail-closed. */
  nextCreateBody: unknown | null;
  /** New sandboxes appear with this state. */
  createRunning: boolean;
  /** Fail this many requests with a 500 before answering normally —
   * simulates a manager mid-redeploy / an NLB flow drop. */
  failNextRequests: number;
  /** Answer park/wake with the step-2 manager's `{ok:true}` shape. */
  legacyParkAnswers: boolean;
  /** Truncate this many 2xx bodies (a dying pod mid-read) before answering
   * normally — exercises the `bad_body` transient path. */
  truncateNextBodies: number;
  /** Answer the next park/wake with this house error (e.g. 503
   * not_configured) instead of a status — a deterministic manager refusal. */
  nextHomeError: { status: number; code: string; message: string } | null;
  close(): Promise<void>;
}

export const startFakeManager = async (): Promise<FakeManager> => {
  const requests: RecordedRequest[] = [];
  const sandboxes = new Map<string, FakeSnapshot>();
  const homes = new Map<string, string>();
  const managed: unknown[] = [];
  const parkStatuses: string[] = ["parked"];
  const wakeStatuses: string[] = ["ready"];
  let refCounter = 0;

  const fake: Partial<FakeManager> = {
    requests,
    sandboxes,
    homes,
    managed,
    parkStatuses,
    wakeStatuses,
    nextCreateError: null,
    nextCreateBody: null,
    createRunning: true,
    failNextRequests: 0,
    legacyParkAnswers: false,
    truncateNextBodies: 0,
    nextHomeError: null,
  };

  const shift = (queue: string[]): string =>
    queue.length > 1 ? (queue.shift() ?? "ready") : (queue[0] ?? "ready");

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      const body: unknown = raw ? JSON.parse(raw) : undefined;
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      requests.push({
        method: req.method ?? "",
        path: `${path}${url.search}`,
        authorization: req.headers.authorization ?? null,
        body,
      });

      const json = (status: number, payload: unknown): void => {
        if ((fake.truncateNextBodies ?? 0) > 0) {
          fake.truncateNextBodies = (fake.truncateNextBodies ?? 0) - 1;
          // A 2xx whose body is cut off mid-stream — undici's json() throws.
          res.writeHead(status, { "content-type": "application/json" });
          res.end('{"truncated');
          return;
        }
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const houseError = (
        status: number,
        code: string,
        message: string,
      ): void => json(status, { error: { code, message, details: [] } });

      if ((fake.failNextRequests ?? 0) > 0) {
        fake.failNextRequests = (fake.failNextRequests ?? 0) - 1;
        return houseError(500, "internal", "simulated mid-redeploy blip");
      }

      if (req.method === "POST" && path === "/v1/sandboxes") {
        const error = fake.nextCreateError;
        if (error) {
          fake.nextCreateError = null;
          return houseError(error.status, error.code, error.message);
        }
        const skewedBody = fake.nextCreateBody;
        if (skewedBody !== null && skewedBody !== undefined) {
          fake.nextCreateBody = null;
          return json(201, skewedBody);
        }
        const spec = body as {
          sandboxId: string;
          runnerId: string;
          payloadHash: string;
        };
        const containerRef = `pod-uid-${(refCounter += 1)}`;
        sandboxes.set(containerRef, {
          sandboxId: spec.sandboxId,
          runnerId: spec.runnerId,
          containerRef,
          running: fake.createRunning ?? true,
          payloadHash: spec.payloadHash,
          phase: fake.createRunning ? "Running" : "Pending",
          waitingReason: null,
        });
        return json(201, { containerRef });
      }

      if (req.method === "GET" && path === "/v1/sandboxes") {
        const runnerId = url.searchParams.get("runnerId");
        return json(200, {
          sandboxes: [...sandboxes.values()]
            .filter((snapshot) => snapshot.runnerId === runnerId)
            .map((snapshot) => ({
              sandboxId: snapshot.sandboxId,
              containerRef: snapshot.containerRef,
              running: snapshot.running,
              payloadHash: snapshot.payloadHash,
              phase: snapshot.phase,
              waitingReason: snapshot.waitingReason,
            })),
        });
      }

      const sandboxAction = /^\/v1\/sandboxes\/([^/]+)\/(start|stop)$/.exec(
        path,
      );
      if (req.method === "POST" && sandboxAction) {
        const [, ref, action] = sandboxAction;
        if (action === "start" && !sandboxes.has(ref ?? "")) {
          return houseError(404, "sandbox_not_found", "no such pod");
        }
        if (action === "stop") sandboxes.delete(ref ?? "");
        return json(200, { ok: true });
      }

      const sandboxDelete = /^\/v1\/sandboxes\/([^/]+)$/.exec(path);
      if (req.method === "DELETE" && sandboxDelete) {
        sandboxes.delete(sandboxDelete[1] ?? "");
        res.writeHead(204).end();
        return;
      }

      if (req.method === "POST" && path === "/v1/homes") {
        const { sandboxId } = body as { sandboxId: string };
        return json(201, { ref: `home-${sandboxId}` });
      }

      if (req.method === "GET" && path === "/v1/homes") {
        const runnerId = url.searchParams.get("runnerId");
        return json(200, {
          homes: [...homes.entries()]
            .filter(([, owner]) => owner === runnerId)
            .map(([sandboxId]) => ({ sandboxId, ref: `home-${sandboxId}` })),
        });
      }

      const homeAction = /^\/v1\/homes\/([^/]+)(?:\/(park|wake))?$/.exec(path);
      if (homeAction) {
        const [, , action] = homeAction;
        if (req.method === "DELETE" && !action) {
          const sandboxId = (homeAction[1] ?? "").replace(/^home-/, "");
          homes.delete(sandboxId);
          res.writeHead(204).end();
          return;
        }
        if (req.method === "POST" && (action === "park" || action === "wake")) {
          const homeError = fake.nextHomeError;
          if (homeError) {
            fake.nextHomeError = null;
            return houseError(
              homeError.status,
              homeError.code,
              homeError.message,
            );
          }
          if (fake.legacyParkAnswers) return json(202, { ok: true });
          return json(200, {
            status: shift(action === "park" ? parkStatuses : wakeStatuses),
          });
        }
      }

      if (req.method === "GET" && path === "/v1/managed") {
        return json(200, { managed });
      }

      houseError(404, "not_found", "No such route");
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  fake.url = `http://127.0.0.1:${port}`;
  fake.close = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
    });
  return fake as FakeManager;
};
