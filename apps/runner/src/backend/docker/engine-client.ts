import { Client, type Dispatcher } from "undici";
import { log } from "../../log";

/**
 * A thin, owned client for the Docker Engine API over its unix socket.
 *
 * Why not the docker CLI: a daemon needs structured errors, exact JSON
 * payloads, and no dependency on a binary being installed in its own image.
 * Why not a third-party client library: the socket is root-equivalent on the
 * host, so the fewer hands on it the better — this is ~150 lines of HTTP over
 * `undici`, which the repo already depends on.
 *
 * The dispatcher is constructed here and passed explicitly, never installed
 * globally (`setGlobalDispatcher` would collide with Prisma's own agent —
 * see the note in packages/api/src/services/onepassword-service.ts).
 */

/**
 * The API version this client is written against. Docker requires the version
 * in the path (the unversioned form is deprecated) and we clamp to what the
 * daemon supports at connect.
 *
 * 1.44 is Docker 25.0 (Jan 2024), and it is the floor modern daemons enforce:
 * Docker 28+ refuses anything older, so a lower target fails outright there.
 * An older daemon that tops out below this simply clamps us down.
 */
const TARGET_API_VERSION = "1.44";

export class DockerEngineError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    message: string,
  ) {
    super(message);
  }
}

export interface EngineTransport {
  request(options: {
    method: "GET" | "HEAD" | "POST" | "PUT" | "DELETE";
    path: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    /** Per-request overrides of the client defaults — image pulls stream for
     * minutes and must not inherit the 120s ceiling. `bodyTimeout` is
     * undici's INTER-CHUNK idle timeout, not a total. */
    headersTimeout?: number;
    bodyTimeout?: number;
  }): Promise<{
    statusCode: number;
    body: {
      text(): Promise<string>;
      json(): Promise<unknown>;
      dump(): Promise<void>;
    };
  }>;
  close(): Promise<void>;
}

/** The real transport: undici over the docker socket. */
export const createSocketTransport = (socketPath: string): EngineTransport => {
  // The hostname is irrelevant over a unix socket; docker documents using
  // `localhost` and ignores it.
  const client = new Client("http://localhost", {
    connect: { socketPath },
    // Image pulls and container creates can be slow on a cold host.
    headersTimeout: 120_000,
    bodyTimeout: 120_000,
  });

  return {
    async request(options) {
      const response: Dispatcher.ResponseData = await client.request({
        method: options.method,
        path: options.path,
        headers: options.headers,
        body: options.body,
        ...(options.headersTimeout !== undefined && {
          headersTimeout: options.headersTimeout,
        }),
        ...(options.bodyTimeout !== undefined && {
          bodyTimeout: options.bodyTimeout,
        }),
      });
      return { statusCode: response.statusCode, body: response.body };
    },
    close: () => client.close(),
  };
};

/** Compare dotted API versions (1.9 < 1.43 — not string order). */
const compareVersions = (a: string, b: string): number => {
  const [aMajor = 0, aMinor = 0] = a.split(".").map(Number);
  const [bMajor = 0, bMinor = 0] = b.split(".").map(Number);
  return aMajor !== bMajor ? aMajor - bMajor : aMinor - bMinor;
};

/**
 * Docker's `filters` query parameter is a JSON-encoded map of string arrays,
 * then URL-encoded. Values within one key are OR'd, keys are AND'd.
 */
export const encodeFilters = (filters: Record<string, string[]>): string =>
  encodeURIComponent(JSON.stringify(filters));

/**
 * Split an image reference for `/images/create`'s `fromImage`/`tag` params.
 *
 * The split is a CORRECTNESS requirement, not tidiness: `fromImage` without a
 * `tag` tells the daemon to pull EVERY tag of the repository. The tag colon is
 * the last `:` AFTER the last `/` (a registry host may carry a port:
 * `ghcr.io:443/onecli/agent:v2`); an untagged ref pins `latest`; a digest ref
 * (`…@sha256:…`) passes whole — the digest already names one image.
 */
export const splitImageRef = (
  image: string,
): { fromImage: string; tag?: string } => {
  if (image.includes("@")) return { fromImage: image };
  const lastSlash = image.lastIndexOf("/");
  const lastColon = image.lastIndexOf(":");
  if (lastColon > lastSlash) {
    return {
      fromImage: image.slice(0, lastColon),
      tag: image.slice(lastColon + 1),
    };
  }
  return { fromImage: image, tag: "latest" };
};

/**
 * Inter-chunk idle allowance for an image pull. The daemon streams progress
 * lines continuously while bytes move, so a genuinely stalled registry SHOULD
 * trip this — it bounds silence, not total duration (a multi-GB pull that
 * keeps reporting progress can run as long as it needs).
 */
const IMAGE_PULL_BODY_TIMEOUT_MS = 300_000;

export class DockerEngine {
  private version = TARGET_API_VERSION;

  constructor(private readonly transport: EngineTransport) {}

  /**
   * Negotiate the API version once, at startup: use ours unless the daemon is
   * older, and refuse outright if the daemon is too new to still speak it.
   */
  async negotiateVersion(): Promise<string> {
    const info = (await this.get("/version", { unversioned: true })) as {
      ApiVersion?: string;
      MinAPIVersion?: string;
    };
    const daemonMax = info.ApiVersion ?? TARGET_API_VERSION;
    const daemonMin = info.MinAPIVersion ?? "1.24";

    if (compareVersions(TARGET_API_VERSION, daemonMin) < 0) {
      throw new DockerEngineError(
        0,
        `daemon requires >= ${daemonMin}`,
        `Docker daemon is too new for this runner (needs API >= ${daemonMin}, this client speaks ${TARGET_API_VERSION}).`,
      );
    }

    this.version =
      compareVersions(TARGET_API_VERSION, daemonMax) > 0
        ? daemonMax
        : TARGET_API_VERSION;
    log("info", "docker engine ready", { apiVersion: this.version });
    return this.version;
  }

  private async send(
    method: "GET" | "HEAD" | "POST" | "PUT" | "DELETE",
    path: string,
    options: {
      json?: unknown;
      body?: Buffer;
      contentType?: string;
      unversioned?: boolean;
      /** Status codes to accept as success beyond 2xx (e.g. 304 already-started). */
      tolerate?: number[];
      /** Per-request timeout overrides (image pulls outlive the defaults). */
      headersTimeout?: number;
      bodyTimeout?: number;
    } = {},
  ): Promise<{ statusCode: number; text: string }> {
    const prefix = options.unversioned ? "" : `/v${this.version}`;
    const body =
      options.json !== undefined ? JSON.stringify(options.json) : options.body;
    const headers: Record<string, string> = {};
    if (options.json !== undefined)
      headers["content-type"] = "application/json";
    else if (options.body) {
      headers["content-type"] =
        options.contentType ?? "application/octet-stream";
    }

    const response = await this.transport.request({
      method,
      path: `${prefix}${path}`,
      headers,
      ...(body !== undefined && { body }),
      ...(options.headersTimeout !== undefined && {
        headersTimeout: options.headersTimeout,
      }),
      ...(options.bodyTimeout !== undefined && {
        bodyTimeout: options.bodyTimeout,
      }),
    });

    const ok =
      (response.statusCode >= 200 && response.statusCode < 300) ||
      (options.tolerate?.includes(response.statusCode) ?? false);

    if (!ok) {
      const detail = await response.body.text().catch(() => "");
      throw new DockerEngineError(
        response.statusCode,
        detail,
        `docker ${method} ${path} failed: ${response.statusCode} ${detail.slice(0, 300)}`,
      );
    }

    // 204s and tolerated 304s have no body worth parsing, but the stream must
    // still be consumed or the connection is never released.
    if (response.statusCode === 204 || response.statusCode === 304) {
      await response.body.dump();
      return { statusCode: response.statusCode, text: "" };
    }

    return {
      statusCode: response.statusCode,
      text: await response.body.text(),
    };
  }

  async get(path: string, options: { unversioned?: boolean } = {}) {
    const { text } = await this.send("GET", path, options);
    return text ? (JSON.parse(text) as unknown) : null;
  }

  async post(
    path: string,
    json?: unknown,
    options: { tolerate?: number[] } = {},
  ) {
    const { text } = await this.send("POST", path, { json, ...options });
    return text ? (JSON.parse(text) as unknown) : null;
  }

  /**
   * Pull an image. NOT `post()`: `/images/create` answers 200 immediately and
   * streams NDJSON progress — one JSON object per line, unparseable as a
   * single document — and a pull that fails MIDWAY still ends as a 200 whose
   * stream carries an `{"error": …}` line. So the body is drained whole (the
   * drain IS the wait for completion), then scanned for the last error line;
   * an outright non-2xx (unknown repository, registry auth) throws from
   * `send` as usual.
   *
   * Whole-buffer by DECISION, not accident: the progress stream for even a
   * multi-GB image is a few MB of text, this path runs once per clean host,
   * and the inter-chunk timeout below bounds a stalled stream. Revisit with
   * an incremental scan only if agent images grow pathological.
   */
  async pullImage(image: string): Promise<void> {
    const { fromImage, tag } = splitImageRef(image);
    const query =
      `fromImage=${encodeURIComponent(fromImage)}` +
      (tag !== undefined ? `&tag=${encodeURIComponent(tag)}` : "");
    const { text } = await this.send("POST", `/images/create?${query}`, {
      bodyTimeout: IMAGE_PULL_BODY_TIMEOUT_MS,
    });

    let lastError: string | undefined;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { error?: unknown };
        if (typeof parsed.error === "string") lastError = parsed.error;
      } catch {
        // A non-JSON line in the progress stream carries no verdict; the
        // pull's outcome is decided by error lines and the status code alone.
      }
    }
    if (lastError !== undefined) {
      throw new DockerEngineError(
        200,
        lastError,
        `docker pull ${image} failed: ${lastError.slice(0, 300)}`,
      );
    }
  }

  /**
   * Existence probe — returns the status code instead of parsing a body
   * (HEAD bodies are empty by definition). Note undici deliberately closes
   * the connection after every HEAD (misbehaving-server interop default),
   * so each probe costs one extra unix-socket dial — harmless here.
   */
  async head(path: string, options: { tolerate?: number[] } = {}) {
    const { statusCode } = await this.send("HEAD", path, options);
    return statusCode;
  }

  async put(path: string, body: Buffer, contentType: string) {
    await this.send("PUT", path, { body, contentType });
  }

  async delete(path: string, options: { tolerate?: number[] } = {}) {
    await this.send("DELETE", path, options);
  }

  close(): Promise<void> {
    return this.transport.close();
  }
}
