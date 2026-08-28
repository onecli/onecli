import type { Duplex } from "node:stream";
import { Client } from "undici";

/**
 * A thin, owned client for the exact six Docker Engine API calls the docker
 * substrate needs — the runner's engine-client philosophy, purpose-sized:
 * the socket is root-equivalent on the host, so the fewer hands on it the
 * better, and this backend additionally needs the one thing no buffering
 * client offers — the exec-start STREAM HIJACK (HTTP Upgrade → raw Duplex).
 *
 * The dispatcher is constructed here and passed explicitly, never installed
 * globally.
 */

/**
 * The API version this client is written against. Docker requires the
 * version in the path (the unversioned form is deprecated) and we clamp to
 * what the daemon supports at connect. 1.44 is Docker 25.0 — the floor
 * modern daemons enforce (Docker 28+ refuses anything older), and every
 * exec endpoint is unchanged from well before it.
 */
const TARGET_API_VERSION = "1.44";

export class DockerEngineError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    message: string,
  ) {
    super(message);
    this.name = "DockerEngineError";
  }
}

/** Compare dotted API versions (1.9 < 1.43 — not string order). */
const compareVersions = (a: string, b: string): number => {
  const [aMajor = 0, aMinor = 0] = a.split(".").map(Number);
  const [bMajor = 0, bMinor = 0] = b.split(".").map(Number);
  return aMajor !== bMajor ? aMajor - bMajor : aMinor - bMinor;
};

/**
 * Docker's `filters` query parameter is a JSON-encoded map of string arrays,
 * then URL-encoded. Multiple entries under the `label` key are AND'd (all
 * must match — the tenancy fence the resolver relies on); values within most
 * other keys are OR'd.
 */
const encodeFilters = (filters: Record<string, string[]>): string =>
  encodeURIComponent(JSON.stringify(filters));

/** The subset of a `/containers/json` row this backend reads. */
export interface ContainerSummary {
  Id: string;
  State?: string;
}

export interface ExecCreateConfig {
  AttachStdin: boolean;
  AttachStdout: boolean;
  AttachStderr: boolean;
  Tty: boolean;
  /** ["VAR=value"] — merged over the container's create-time env. */
  Env: string[];
  Cmd: string[];
  User: string;
  ConsoleSize?: [number, number];
}

export interface ExecInspectResult {
  Running: boolean;
  ExitCode: number | null;
}

/** The six calls the docker substrate makes — an interface so the resolver
 *  and exec-backend tests inject plain fakes. */
export interface DockerEngineApi {
  negotiateVersion(): Promise<string>;
  listContainers(labels: string[]): Promise<ContainerSummary[]>;
  execCreate(containerId: string, config: ExecCreateConfig): Promise<string>;
  /**
   * Start the exec with the stream hijack: `Connection: Upgrade` +
   * `Upgrade: tcp` → 101 + a raw bidirectional Duplex. Tty=true is a raw
   * byte stream; Tty=false is the daemon's 8-byte-header multiplexed
   * framing (see demux.ts). Client→daemon stdin is unframed in both modes.
   */
  execStart(execId: string, tty: boolean): Promise<Duplex>;
  /** Resize the exec's TTY — only meaningful when created with Tty=true. */
  execResize(execId: string, rows: number, cols: number): Promise<void>;
  execInspect(execId: string): Promise<ExecInspectResult>;
  close(): Promise<void>;
}

export const createDockerEngineApi = (socketPath: string): DockerEngineApi => {
  // The hostname is irrelevant over a unix socket; docker documents using
  // `localhost` and ignores it.
  const client = new Client("http://localhost", {
    connect: { socketPath },
    headersTimeout: 30_000,
    bodyTimeout: 30_000,
  });

  let version = TARGET_API_VERSION;

  // Negotiate the API version LAZILY and memoize only on SUCCESS: a failed
  // attempt (a daemon blip, or a socket-proxy that comes up after the
  // terminator) clears the cache so the next call retries, instead of pinning
  // TARGET_API_VERSION forever and permanently breaking a pre-1.44 daemon.
  let negotiated: Promise<string> | null = null;
  const ensureVersion = (): Promise<string> => {
    if (!negotiated) {
      negotiated = negotiateOnce().catch((error: unknown) => {
        negotiated = null;
        throw error;
      });
    }
    return negotiated;
  };

  const negotiateOnce = async (): Promise<string> => {
    const { text } = await send("GET", "/version", { unversioned: true });
    const info = JSON.parse(text) as {
      ApiVersion?: string;
      MinAPIVersion?: string;
    };
    const daemonMax = info.ApiVersion ?? TARGET_API_VERSION;
    const daemonMin = info.MinAPIVersion ?? "1.24";
    if (compareVersions(TARGET_API_VERSION, daemonMin) < 0) {
      throw new DockerEngineError(
        0,
        `daemon requires >= ${daemonMin}`,
        `Docker daemon is too new for this terminator (needs API >= ${daemonMin}, this client speaks ${TARGET_API_VERSION}).`,
      );
    }
    version =
      compareVersions(TARGET_API_VERSION, daemonMax) > 0
        ? daemonMax
        : TARGET_API_VERSION;
    return version;
  };

  const send = async (
    method: "GET" | "POST",
    path: string,
    options: { json?: unknown; unversioned?: boolean } = {},
  ): Promise<{ statusCode: number; text: string }> => {
    const prefix = options.unversioned ? "" : `/v${version}`;
    const response = await client.request({
      method,
      path: `${prefix}${path}`,
      ...(options.json !== undefined && {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(options.json),
      }),
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const detail = await response.body.text().catch(() => "");
      throw new DockerEngineError(
        response.statusCode,
        detail,
        `docker ${method} ${path} failed: ${response.statusCode} ${detail.slice(0, 300)}`,
      );
    }
    if (response.statusCode === 204) {
      await response.body.dump();
      return { statusCode: response.statusCode, text: "" };
    }
    return {
      statusCode: response.statusCode,
      text: await response.body.text(),
    };
  };

  return {
    negotiateVersion: ensureVersion,

    async listContainers(labels) {
      await ensureVersion();
      const filters = encodeFilters({ label: labels });
      // Default all=false: running containers only — exactly the state gate
      // the resolver needs (a created/exited container is still "waking").
      const { text } = await send("GET", `/containers/json?filters=${filters}`);
      return JSON.parse(text) as ContainerSummary[];
    },

    async execCreate(containerId, config) {
      await ensureVersion();
      const { text } = await send(
        "POST",
        `/containers/${encodeURIComponent(containerId)}/exec`,
        { json: { ...config, Detach: false } },
      );
      const created = JSON.parse(text) as { Id?: string };
      if (!created.Id) {
        throw new DockerEngineError(
          201,
          text.slice(0, 300),
          "docker exec create answered without an Id",
        );
      }
      return created.Id;
    },

    async execStart(execId, tty) {
      await ensureVersion();
      // The hijack MUST ride dispatch(): the high-level client.upgrade() has
      // no body field, and /exec/{id}/start carries the ExecStartConfig JSON
      // (an empty body would default Tty=false and silently break the PTY
      // arm). onRequestUpgrade hands back the raw socket on the 101.
      return new Promise<Duplex>((resolve, reject) => {
        let settled = false;
        const fail = (error: Error): void => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        let refusalStatus = 0;
        const refusalBody: Buffer[] = [];
        client.dispatch(
          {
            origin: "http://localhost",
            method: "POST",
            path: `/v${version}/exec/${encodeURIComponent(execId)}/start`,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ Detach: false, Tty: tty }),
            upgrade: "tcp",
          },
          {
            // undici's handler contract requires onRequestStart whenever any
            // new-style callback is present — nothing to do at request start.
            onRequestStart() {
              // intentionally empty
            },
            onRequestUpgrade(_controller, _statusCode, _headers, socket) {
              if (settled) {
                socket.destroy();
                return;
              }
              settled = true;
              // Guest output can be on the wire the instant the 101 lands
              // (a fast command finishes in ms) — pause so nothing is
              // emitted before the caller wires its listeners and resumes.
              socket.pause();
              resolve(socket);
            },
            // A refusal (404 no such exec, 409 container stopped) arrives as
            // a plain response instead of the upgrade — collect and throw.
            onResponseStart(_controller, statusCode) {
              refusalStatus = statusCode;
            },
            onResponseData(_controller, chunk) {
              refusalBody.push(chunk);
            },
            onResponseEnd() {
              const detail = Buffer.concat(refusalBody).toString("utf8");
              fail(
                new DockerEngineError(
                  refusalStatus,
                  detail,
                  `docker exec start failed: ${refusalStatus} ${detail.slice(0, 300)}`,
                ),
              );
            },
            onResponseError(_controller, error) {
              fail(error instanceof Error ? error : new Error(String(error)));
            },
          },
        );
      });
    },

    async execResize(execId, rows, cols) {
      await ensureVersion();
      await send(
        "POST",
        `/exec/${encodeURIComponent(execId)}/resize?h=${rows}&w=${cols}`,
      );
    },

    async execInspect(execId) {
      await ensureVersion();
      const { text } = await send(
        "GET",
        `/exec/${encodeURIComponent(execId)}/json`,
      );
      const inspected = JSON.parse(text) as {
        Running?: boolean;
        ExitCode?: number | null;
      };
      return {
        Running: inspected.Running === true,
        ExitCode:
          typeof inspected.ExitCode === "number" ? inspected.ExitCode : null,
      };
    },

    close: () => client.close(),
  };
};
