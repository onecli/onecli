import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Outbound fetcher for admin-supplied SSO URLs (metadata / OIDC discovery).
 * Guards: https-only, private/loopback/link-local/ULA targets rejected (via
 * a one-shot DNS resolution), redirects not followed, response capped at
 * 1 MB, bodies never reflected into errors by callers. Accepted residual
 * (documented): DNS rebinding — the resolved IP is not pinned for the
 * actual request; the attacker pool is authenticated paying org admins.
 */

type SafeFetchResult =
  | { ok: true; status: number; body: string }
  | { ok: false; reason: string };

const MAX_BODY_BYTES = 1_000_000;

const isPrivateV4 = (ip: string): boolean => {
  const parts = ip.split(".").map(Number);
  const [a, b] = [parts[0] ?? 0, parts[1] ?? 0];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
};

const isPrivateV6 = (ip: string): boolean => {
  const lower = ip.toLowerCase();
  return (
    lower === "::1" ||
    lower === "::" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") || // ULA fc00::/7
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb") || // link-local fe80::/10
    lower.startsWith("::ffff:") // v4-mapped — re-checked below anyway
  );
};

const isPrivateAddress = (ip: string): boolean => {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return isPrivateV4(mapped);
  return isIP(ip) === 4 ? isPrivateV4(ip) : isPrivateV6(ip);
};

export const safeFetch = async (rawUrl: string): Promise<SafeFetchResult> => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "Not a valid URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "Only https URLs are allowed" };
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return { ok: false, reason: "Internal hostnames are not allowed" };
  }
  try {
    const target = isIP(host) ? host : (await lookup(host)).address;
    if (isPrivateAddress(target)) {
      return { ok: false, reason: "URL resolves to a private address" };
    }
  } catch {
    return { ok: false, reason: "Hostname does not resolve" };
  }

  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: { "user-agent": "OneCLI-SSO-Check/1.0" },
    });
  } catch {
    return { ok: false, reason: "Request failed or timed out" };
  }
  if (res.status >= 300 && res.status < 400) {
    return {
      ok: false,
      reason: "URL redirects. Provide the final (post-redirect) URL",
    };
  }
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    return { ok: false, reason: "Response is too large" };
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) {
    return { ok: false, reason: "Response is too large" };
  }
  return {
    ok: true,
    status: res.status,
    body: new TextDecoder().decode(buf),
  };
};

export type SsoUrlFetcher = typeof safeFetch;
