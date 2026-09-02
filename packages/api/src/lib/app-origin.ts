/**
 * Resolving "where does this instance live?" — the primitives every
 * origin-dependent call site composes.
 *
 * The rule, applied everywhere: an **explicitly configured** URL wins —
 * the canonical `ONECLI_EXTERNAL_URL` (or its `APP_URL` alias) for anything a
 * browser will visit, `API_URL` (or the external URL's derivation) for
 * anything the api-server answers (OAuth redirect URIs); failing that, the
 * origin of the request in hand; failing that, the caller's own last resort.
 *
 * The derivation itself lives in `public-origins.ts` (the one resolver); this
 * module re-exports the configured-vs-defaulted facades beside the
 * request-plane helper so existing importers keep one import site. The
 * distinction that matters is *configured* vs *defaulted*: a defaulted
 * localhost value read as a configured-or-not signal silently strands
 * self-hosters on localhost — which is why the facades return `undefined`
 * when nothing was configured.
 */

import { HOST_PATTERN } from "./public-origins";

export {
  configuredApiUrl,
  configuredAppUrl,
  normalizeOrigin,
} from "./public-origins";

/**
 * Structural shape of a header bag. Deliberately not `Headers`: this package
 * must not import from `next/`, and Next's `ReadonlyHeaders` (from
 * `next/headers`) satisfies this without the two ever meeting in the type
 * system. A DOM/undici `Headers` satisfies it too.
 */
interface HeaderLookup {
  get(name: string): string | null | undefined;
}

/**
 * Origin (scheme + host) the client used to reach us, or `undefined` when the
 * headers carry no usable host.
 *
 * Trusts reverse-proxy headers (`X-Forwarded-Host` / `X-Forwarded-Proto`) so
 * this works behind nginx, Caddy, Cloudflare Tunnel, ngrok, etc., and falls
 * back to `Host` for direct access (e.g. a Docker port-forward).
 *
 * `fallbackProto` is only consulted on the `Host` path; a forwarded host with
 * no forwarded proto stays `http`, preserving long-standing behavior.
 *
 * A present-but-blank `X-Forwarded-Host` falls through to `Host` rather than
 * yielding a hostless `http://`. That is the one intentional departure from the
 * inlined version this replaced, which returned the broken string.
 */
export const originFromHeaders = (
  headers: HeaderLookup,
  fallbackProto = "http",
): string | undefined => {
  const rawProto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  // Only the two schemes we serve; anything else (javascript:, data:, a
  // malformed value) is discarded rather than propagated into a redirect.
  const forwardedProto =
    rawProto === "https" || rawProto === "http" ? rawProto : undefined;

  const firstHost = (value: string | null | undefined) => {
    const host = value?.split(",")[0]?.trim();
    return host && HOST_PATTERN.test(host) ? host : undefined;
  };

  const forwardedHost = firstHost(headers.get("x-forwarded-host"));
  if (forwardedHost) return `${forwardedProto ?? "http"}://${forwardedHost}`;

  const host = firstHost(headers.get("host"));
  if (host) return `${forwardedProto ?? fallbackProto}://${host}`;

  return undefined;
};
