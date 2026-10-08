import { readFile } from "node:fs/promises";
import { Client, type Dispatcher } from "undici";
import { log } from "../../log";

/**
 * A minimal Kubernetes API client, the `engine-client.ts` shape for this
 * substrate. Deliberately hand-rolled rather than an SDK: the backend touches
 * eight endpoints (Jobs, Pods, PVCs, Secrets, Services, plus a one-off probe),
 * and the runner image must stay as small as the docker arm's. Everything is
 * typed loosely as `unknown` at the wire and narrowed by the backend, which
 * reads only the handful of fields it needs.
 *
 * Credentials are the in-cluster projected ServiceAccount token and the
 * cluster CA, read from their well-known paths. The token file is re-read on
 * every request because kubelet rotates bound tokens in place.
 */

/** The in-cluster ServiceAccount mount, as projected by kubelet. */
const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

export class KubeApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    message: string,
  ) {
    super(message);
    this.name = "KubeApiError";
  }
}

export interface KubeTransport {
  request(options: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{
    statusCode: number;
    body: {
      text(): Promise<string>;
      dump(): Promise<void>;
    };
  }>;
  close(): Promise<void>;
}

export interface InClusterOptions {
  /** `https://host:port` of the API server (from KUBERNETES_SERVICE_HOST/PORT). */
  server: string;
  /** Override of the projected ServiceAccount directory (tests only). */
  serviceAccountDir?: string;
}

/**
 * The real transport: TLS to the API server trusting ONLY the cluster CA,
 * bearer-authenticated with the projected token. The token is read per
 * request (bound tokens rotate), the CA once (it does not).
 */
export const createInClusterTransport = async (
  options: InClusterOptions,
): Promise<KubeTransport> => {
  const dir = options.serviceAccountDir ?? SA_DIR;
  const ca = await readFile(`${dir}/ca.crt`, "utf8");
  const tokenPath = `${dir}/token`;
  const client = new Client(options.server, {
    connect: { ca },
    headersTimeout: 60_000,
    bodyTimeout: 60_000,
  });

  return {
    async request(request) {
      const token = (await readFile(tokenPath, "utf8")).trim();
      const response: Dispatcher.ResponseData = await client.request({
        method: request.method,
        path: request.path,
        headers: {
          ...request.headers,
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
        body: request.body,
      });
      return { statusCode: response.statusCode, body: response.body };
    },
    close: () => client.close(),
  };
};

/** Read the API server address kubelet injects into every pod. */
export const inClusterServer = (
  env: NodeJS.ProcessEnv = process.env,
): string | null => {
  const host = env.KUBERNETES_SERVICE_HOST?.trim();
  const port = env.KUBERNETES_SERVICE_PORT?.trim() || "443";
  if (!host) return null;
  // IPv6 service hosts arrive bare; a URL authority needs the brackets.
  return `https://${host.includes(":") ? `[${host}]` : host}:${port}`;
};

/** Encode a label selector map as the `labelSelector` query value. */
export const labelSelector = (labels: Record<string, string>): string =>
  encodeURIComponent(
    Object.entries(labels)
      .map(([key, value]) => `${key}=${value}`)
      .join(","),
  );

export interface KubeListResult<T> {
  items: T[];
}

export class KubeClient {
  constructor(private readonly transport: KubeTransport) {}

  private async send(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    options: { json?: unknown; tolerate?: number[] } = {},
  ): Promise<{ statusCode: number; text: string }> {
    const headers: Record<string, string> = {};
    const body =
      options.json !== undefined ? JSON.stringify(options.json) : undefined;
    if (body !== undefined) headers["content-type"] = "application/json";

    const response = await this.transport.request({
      method,
      path,
      headers,
      ...(body !== undefined && { body }),
    });

    const ok =
      (response.statusCode >= 200 && response.statusCode < 300) ||
      (options.tolerate?.includes(response.statusCode) ?? false);

    if (!ok) {
      const detail = await response.body.text().catch(() => "");
      throw new KubeApiError(
        response.statusCode,
        detail,
        `kubernetes ${method} ${path} failed: ${response.statusCode} ${detail.slice(0, 300)}`,
      );
    }

    return {
      statusCode: response.statusCode,
      text: await response.body.text(),
    };
  }

  async get(path: string, options: { tolerate?: number[] } = {}) {
    const { statusCode, text } = await this.send("GET", path, options);
    if (options.tolerate?.includes(statusCode)) return null;
    return text ? (JSON.parse(text) as unknown) : null;
  }

  async post(
    path: string,
    json: unknown,
    options: { tolerate?: number[] } = {},
  ) {
    const { text } = await this.send("POST", path, { json, ...options });
    return text ? (JSON.parse(text) as unknown) : null;
  }

  /**
   * Delete with a propagation policy. `Foreground` means the call returns once
   * the object AND its dependents are gone; for a Job that is the pod, which
   * is what the lifecycle needs ("stopped" must mean the process is dead).
   * `Background` returns immediately; used for best-effort cleanup only.
   */
  async delete(
    path: string,
    options: {
      propagation?: "Foreground" | "Background";
      gracePeriodSeconds?: number;
      tolerate?: number[];
    } = {},
  ) {
    const query = new URLSearchParams();
    if (options.propagation)
      query.set("propagationPolicy", options.propagation);
    if (options.gracePeriodSeconds !== undefined)
      query.set("gracePeriodSeconds", String(options.gracePeriodSeconds));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    await this.send("DELETE", `${path}${suffix}`, {
      tolerate: options.tolerate ?? [404],
    });
  }

  /** The API server's own version, the boot-time reachability check. */
  async version(): Promise<string> {
    const info = (await this.get("/version")) as { gitVersion?: string } | null;
    const version = info?.gitVersion ?? "unknown";
    log("info", "kubernetes api ready", { version });
    return version;
  }
}
