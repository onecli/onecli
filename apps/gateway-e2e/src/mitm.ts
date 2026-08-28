import { readFileSync } from "node:fs";

import { ProxyAgent, request } from "undici";

import { flattenHeaders, makeResponse, type HttpResponse } from "./http.js";
import { proxyAuthHeader } from "./proxy.js";

/**
 * Drive the gateway's MITM path the way an agent actually does.
 *
 * `CONNECT` to open a tunnel, then a TLS handshake *inside* it against a
 * certificate the gateway mints on the fly and signs with its own CA. Trusting
 * that CA is the whole point: it is what lets the gateway see, enforce on and
 * inject into traffic the client believes is end-to-end encrypted.
 *
 * `requestTls.ca` REPLACES Node's default root set rather than adding to it, so
 * the gateway's CA is the client's only root of trust — a forged certificate
 * from anything BUT the gateway fails the handshake.
 */
export interface MitmRequestOptions {
  /** `127.0.0.1:<port>` of the upstream to tunnel to. */
  readonly authority: string;
  readonly path: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Required: the gateway refuses an untokened CONNECT outright. */
  readonly token: string;
  /** The gateway's CA, from its data dir — the client's only root of trust. */
  readonly caPath: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export const throughMitm = async (
  gatewayOrigin: string,
  options: MitmRequestOptions,
): Promise<HttpResponse> => {
  const agent = new ProxyAgent({
    uri: gatewayOrigin,
    token: proxyAuthHeader(options.token),
    requestTls: { ca: readFileSync(options.caPath, "utf8") },
  });

  try {
    const res = await request(`https://${options.authority}${options.path}`, {
      dispatcher: agent,
      method: options.method ?? "GET",
      ...(options.headers === undefined
        ? {}
        : { headers: { ...options.headers } }),
      ...(options.body === undefined ? {} : { body: options.body }),
    });
    return makeResponse(
      res.statusCode,
      flattenHeaders(res.headers),
      await res.body.text(),
    );
  } finally {
    await agent.close();
  }
};
