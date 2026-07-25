/**
 * Resolving "where does this instance live?" — the two primitives every
 * origin-dependent call site composes.
 *
 * The rule, applied everywhere: the app origin is the **explicitly configured**
 * `APP_URL`; failing that, the origin of the request in hand; failing that, the
 * caller's own last resort.
 *
 * The distinction that matters is *configured* vs *defaulted*: `lib/env.ts`
 * gives `APP_URL` a `http://localhost:10254` fallback, so that constant can
 * never be falsy and can never tell the two apart. Reading it as a
 * configured-or-not signal silently strands self-hosters on localhost — see
 * `configuredAppUrl` below.
 */

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
 * A syntactically valid `host` or `host:port` — a registered name or an IP
 * literal, optionally bracketed for IPv6.
 *
 * Header values are attacker-influenceable and the origins built from them end
 * up in `Location` headers and, on the OAuth fragment-bridge path, inside a
 * `<script>` block. `JSON.stringify` does not escape `</script>`, so an
 * unvalidated host could close the script element. Constraining the character
 * set at the source removes that sink for every consumer, and drops malformed
 * origins rather than emitting a redirect that goes nowhere.
 */
const HOST_PATTERN = /^(?:[A-Za-z0-9._~-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/** First env var with a non-empty value, ignoring surrounding whitespace. */
const firstConfigured = (...values: (string | undefined)[]) => {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
};

/**
 * The public app URL the operator explicitly configured, or `undefined` when
 * they configured none.
 *
 * `undefined` is the whole point: it is what lets a call site say "…and if
 * nothing was configured, use the request origin instead". Never use the
 * `APP_URL` constant from `lib/env.ts` for that decision — it is defaulted, so
 * `APP_URL || fallback` is dead code and the fallback never runs.
 *
 * Empty and whitespace-only values count as unconfigured, so an env var that is
 * merely *present* (an `APP_URL=` line, a compose passthrough) does not
 * masquerade as a configured URL. Trailing slashes are stripped so the result
 * concatenates cleanly with a leading-slash path.
 */
export const configuredAppUrl = (): string | undefined =>
  firstConfigured(
    process.env.APP_URL,
    process.env.NEXT_PUBLIC_APP_URL,
  )?.replace(/\/+$/, "");

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
