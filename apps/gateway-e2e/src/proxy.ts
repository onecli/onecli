import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";

/**
 * Driving the gateway as an agent does.
 *
 * The absolute-form path (`GET http://host/p HTTP/1.1` sent to the proxy) runs
 * the same connect-resolution, policy and forwarding pipeline as the CONNECT
 * MITM path, but needs no TLS and no CA — which makes it the cheapest way to
 * cover the bulk of the gateway's behavior. CONNECT gets its own focused tests.
 */

export interface ProxyResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  header(name: string): string | undefined;
  json(): unknown;
}

export interface ProxyRequestOptions {
  readonly method?: string;
  /** Absolute target URL, e.g. `http://127.0.0.1:41234/v1/models`. */
  readonly url: string;
  /** Agent token. Omitted means an unauthenticated proxy request. */
  readonly token?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
}

/** The convention the gateway parses: `Basic base64("x:<token>")`. */
export const proxyAuthHeader = (token: string): string =>
  `Basic ${Buffer.from(`x:${token}`).toString("base64")}`;

export const throughProxy = (
  gatewayOrigin: string,
  options: ProxyRequestOptions,
): Promise<ProxyResponse> => {
  const gateway = new URL(gatewayOrigin);
  const target = new URL(options.url);

  const headers: Record<string, string> = {
    // A proxy request carries the TARGET's authority, not the proxy's.
    host: target.host,
    ...options.headers,
  };
  if (options.token !== undefined) {
    headers["proxy-authorization"] = proxyAuthHeader(options.token);
  }
  if (options.body !== undefined) {
    headers["content-length"] = String(Buffer.byteLength(options.body));
  }

  return new Promise<ProxyResponse>((resolve, reject) => {
    const req = httpRequest(
      {
        host: gateway.hostname,
        port: gateway.port,
        method: options.method ?? "GET",
        // Absolute-form request-target — this is what marks it as proxy traffic.
        path: options.url,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const flat: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") flat[k.toLowerCase()] = v;
            else if (Array.isArray(v)) flat[k.toLowerCase()] = v.join(", ");
          }
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            headers: flat,
            body,
            header: (name: string) => flat[name.toLowerCase()],
            json: () => JSON.parse(body) as unknown,
          });
        });
      },
    );

    req.setTimeout(options.timeoutMs ?? 15_000, () => {
      req.destroy(new Error(`proxy request to ${options.url} timed out`));
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
};

/** A response body as the client actually received it, chunk by chunk. */
export interface StreamedResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** One entry per `data` event, with ms since the response head arrived. */
  readonly chunks: ReadonlyArray<{ text: string; atMs: number }>;
  readonly body: string;
}

/**
 * Read a response without buffering it, recording when each chunk arrived.
 *
 * `throughProxy` concatenates the body, which makes a streaming gateway and one
 * that collects the whole response before replying look identical. Streaming is
 * the gateway's stated core requirement, so it needs a client that can tell
 * them apart.
 */
export const streamThroughProxy = (
  gatewayOrigin: string,
  // `body` is excluded rather than ignored: this client never writes one, and
  // accepting the field would let a caller send a POST whose body silently
  // vanished.
  options: Omit<ProxyRequestOptions, "body">,
): Promise<StreamedResponse> => {
  const gateway = new URL(gatewayOrigin);
  const target = new URL(options.url);

  const headers: Record<string, string> = {
    host: target.host,
    ...options.headers,
  };
  if (options.token !== undefined) {
    headers["proxy-authorization"] = proxyAuthHeader(options.token);
  }

  return new Promise<StreamedResponse>((resolve, reject) => {
    const req = httpRequest(
      {
        host: gateway.hostname,
        port: gateway.port,
        method: options.method ?? "GET",
        path: options.url,
        headers,
      },
      (res) => {
        const startedAt = Date.now();
        const chunks: { text: string; atMs: number }[] = [];
        res.on("data", (c: Buffer) =>
          chunks.push({
            text: c.toString("utf8"),
            atMs: Date.now() - startedAt,
          }),
        );
        res.on("end", () => {
          const flat: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") flat[k.toLowerCase()] = v;
            else if (Array.isArray(v)) flat[k.toLowerCase()] = v.join(", ");
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: flat,
            chunks,
            body: chunks.map((c) => c.text).join(""),
          });
        });
      },
    );

    req.setTimeout(options.timeoutMs ?? 15_000, () => {
      req.destroy(new Error(`streamed request to ${options.url} timed out`));
    });
    req.on("error", reject);
    req.end();
  });
};

/** The status line and headers a `CONNECT` attempt came back with. */
export interface ConnectResult {
  readonly status: number;
  readonly statusLine: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Issue a raw `CONNECT` and read only the gateway's reply.
 *
 * Deliberately socket-level: this exercises the tunnel-establishment path, which
 * is a different code path from the absolute-form one — and the two have already
 * drifted in the gateway, so both are worth pinning independently.
 */
export const connectThroughProxy = (
  gatewayOrigin: string,
  authority: string,
  options: { readonly token?: string; readonly timeoutMs?: number } = {},
): Promise<ConnectResult> => {
  const gateway = new URL(gatewayOrigin);

  return new Promise<ConnectResult>((resolve, reject) => {
    const socket = netConnect(Number(gateway.port), gateway.hostname, () => {
      const auth =
        options.token !== undefined
          ? `Proxy-Authorization: ${proxyAuthHeader(options.token)}\r\n`
          : "";
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`,
      );
    });

    socket.setTimeout(options.timeoutMs ?? 15_000, () => {
      socket.destroy(new Error(`CONNECT ${authority} timed out`));
    });

    let buffered = "";
    socket.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const end = buffered.indexOf("\r\n\r\n");
      if (end === -1) return; // Headers not complete yet.

      const [statusLine = "", ...rest] = buffered.slice(0, end).split("\r\n");
      const headers: Record<string, string> = {};
      for (const line of rest) {
        const idx = line.indexOf(":");
        if (idx > 0) {
          headers[line.slice(0, idx).trim().toLowerCase()] = line
            .slice(idx + 1)
            .trim();
        }
      }
      socket.destroy();
      resolve({
        status: Number.parseInt(statusLine.split(" ")[1] ?? "0", 10),
        statusLine,
        headers,
      });
    });

    socket.on("error", reject);
  });
};

/** A request the gateway is deliberately holding, plus its eventual response. */
export interface HeldRequest {
  /** Resolves when the gateway finally answers — after an approval decision. */
  readonly response: Promise<ProxyResponse>;
}

/**
 * Send a request and assert the gateway produces no response bytes for `ms`.
 *
 * The pending response is returned wrapped in an object on purpose: an `async`
 * function that returns a promise auto-flattens it, so handing the promise back
 * bare would make every caller await the very request we want left held.
 */
export const startHeldRequest = async (
  gatewayOrigin: string,
  options: ProxyRequestOptions,
  ms: number,
): Promise<HeldRequest> => {
  const inFlight = throughProxy(gatewayOrigin, {
    ...options,
    timeoutMs: 120_000,
  });
  let settled = false;
  // Attach a no-op rejection handler so a later failure is never an unhandled
  // rejection while the test is still setting up.
  void inFlight.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise((r) => setTimeout(r, ms));
  if (settled) {
    throw new Error(
      `expected the request to be held, but it completed within ${String(ms)}ms`,
    );
  }
  return { response: inFlight };
};
