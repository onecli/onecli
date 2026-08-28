import { parse } from "tldts";

/**
 * Decides the `Domain` attribute of the self-hosted session cookie.
 *
 * Host-only (no attribute) is the default and the safest: the cookie belongs
 * to exactly the API's host. But a deployment that serves the dashboard and
 * the api-server on *sibling subdomains* (`onecli.example.com` +
 * `api.onecli.example.com`) needs the cookie to span their shared parent, or
 * the dashboard's server-rendered pages never see a session and every visitor
 * bounces back to the login page.
 *
 * Pure and argument-driven — reading the environment and logging the outcome
 * are the caller's job (`getOnpremAuth`), which keeps every rule here unit-
 * testable without env stubbing.
 *
 * Every public-suffix decision passes `allowPrivateDomains: true`. The
 * default tldts profile ignores the PSL's private section, under which
 * `a.ngrok-free.app` and `b.ngrok-free.app` would appear to share the
 * registrable domain `ngrok-free.app` — and browsers, which honour the full
 * list, would silently discard a cookie scoped to it. The failure mode is a
 * login that never sticks and never logs anything, so the stricter profile is
 * load-bearing, not defensive polish.
 */

export interface CookieDomainInput {
  /** Raw `BETTER_AUTH_COOKIE_DOMAIN` value (untrimmed; may be undefined). */
  override?: string;
  /** The operator-configured dashboard URL (`configuredAppUrl()`). */
  appUrl?: string;
  /** The operator-configured api-server URL (`configuredApiUrl()`). */
  apiUrl?: string;
}

export type CookieDomainResolution =
  | {
      kind: "shared";
      /** The value for the cookie's `Domain` attribute (no leading dot). */
      domain: string;
      source: "override" | "derived";
      warnings: string[];
    }
  | {
      kind: "host-only";
      reason:
        | "same-host" // dashboard and API share a hostname — ports differ at most
        | "unconfigured" // APP_URL/API_URL absent or unparseable; nothing to derive from
        | "opt-out" // BETTER_AUTH_COOKIE_DOMAIN=none
        | "cross-site"; // hosts share no registrable parent — no cookie can span them
      warnings: string[];
    };

/** `URL.hostname`, lowercased, trailing dot dropped; undefined when unparseable. */
const hostnameOf = (url: string): string | undefined => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return undefined;
  }
};

/**
 * The registrable domain of a host under the full PSL (ICANN + private
 * sections), or undefined for hosts no cookie domain can be built from:
 * `localhost`, IP literals, single labels, and public-suffix hosts themselves.
 */
const registrableDomainOf = (host: string): string | undefined =>
  parse(host, { allowPrivateDomains: true }).domain ?? undefined;

/**
 * The longest common **label-wise** suffix of two hostnames — the most
 * specific parent that covers both, per the upstream guidance to scope the
 * cookie as narrowly as possible. Label-wise so `app.example.com` vs
 * `myapp.example.com` yields `example.com`, never the string-suffix artifact
 * `app.example.com`.
 */
const commonLabelSuffix = (a: string, b: string): string => {
  const left = a.split(".");
  const right = b.split(".");
  const shared: string[] = [];
  for (;;) {
    const label = left.pop();
    if (label === undefined || label !== right.pop()) break;
    shared.unshift(label);
  }
  return shared.join(".");
};

/**
 * The override reduced to a bare, punycode hostname — or undefined if it is
 * not one. A `Domain` attribute is a host and nothing else: a browser drops
 * the entire cookie if it carries a scheme, port, path, or userinfo (RFC 6265
 * §5.3), so those must fail here and fall back to derivation rather than ship
 * an unusable cookie. Routing the value through `URL` also IDNA-encodes it
 * (`münchen.example.com` → `xn--mnchen-3ya.example.com`), matching what
 * `URL.hostname` already did to the derived hosts — a raw-unicode `Domain`
 * would 500 the Set-Cookie serializer.
 */
const normalizeOverride = (value: string): string | undefined => {
  const trimmed = value.trim().replace(/^\.+/, "").replace(/\.+$/, "");
  // A hostname has none of these; their presence means a URL/authority form
  // slipped through, which must not become a Domain attribute.
  if (!trimmed || /[/@?#:\s]/.test(trimmed)) return undefined;
  try {
    return new URL(`https://${trimmed}`).hostname;
  } catch {
    return undefined;
  }
};

/** True when `host` is `domain` or a subdomain of it (label-wise). */
const isLabelSuffix = (domain: string, host: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

export const resolveCookieDomain = (
  input: CookieDomainInput,
): CookieDomainResolution => {
  const warnings: string[] = [];
  const appHost = input.appUrl ? hostnameOf(input.appUrl) : undefined;
  const apiHost = input.apiUrl ? hostnameOf(input.apiUrl) : undefined;
  if (input.appUrl && !appHost) {
    warnings.push(
      `APP_URL is not a parseable URL (${JSON.stringify(input.appUrl)}) — ` +
        "it cannot inform the session cookie's domain.",
    );
  }
  if (input.apiUrl && !apiHost) {
    warnings.push(
      `API_URL is not a parseable URL (${JSON.stringify(input.apiUrl)}) — ` +
        "it cannot inform the session cookie's domain.",
    );
  }

  const override = input.override?.trim();
  if (override) {
    if (override.toLowerCase() === "none") {
      return { kind: "host-only", reason: "opt-out", warnings };
    }
    const domain = normalizeOverride(override);
    if (domain && registrableDomainOf(domain)) {
      for (const [name, host] of [
        ["APP_URL", appHost],
        ["API_URL", apiHost],
      ] as const) {
        if (host && !isLabelSuffix(domain, host)) {
          warnings.push(
            `BETTER_AUTH_COOKIE_DOMAIN=${domain} does not cover the ${name} ` +
              `host ${host} — browsers will not send the session cookie there.`,
          );
        }
      }
      return { kind: "shared", domain, source: "override", warnings };
    }
    warnings.push(
      `BETTER_AUTH_COOKIE_DOMAIN=${JSON.stringify(override)} is not a usable ` +
        "cookie domain (it must be a registrable domain — not a public " +
        "suffix, IP address, or single label). Falling back to automatic " +
        "derivation.",
    );
  }

  if (!appHost || !apiHost) {
    return { kind: "host-only", reason: "unconfigured", warnings };
  }
  if (appHost === apiHost) {
    return { kind: "host-only", reason: "same-host", warnings };
  }

  const appRegistrable = registrableDomainOf(appHost);
  const apiRegistrable = registrableDomainOf(apiHost);
  if (!appRegistrable || !apiRegistrable || appRegistrable !== apiRegistrable) {
    return { kind: "host-only", reason: "cross-site", warnings };
  }

  // Same registrable domain, different hosts: span the most specific shared
  // parent. The registrable domain is a label-suffix of both hosts, so the
  // common suffix is at least that — never empty, never a bare public suffix.
  const domain = commonLabelSuffix(appHost, apiHost);

  // When the most specific shared parent IS the registrable root (the common
  // apex + api-subdomain shape), the cookie reaches EVERY subdomain of the
  // domain — a status page or marketing site CNAME'd onto a sibling host would
  // receive the session bearer token. Nothing narrower is possible here, so
  // this is derived rather than refused, but it is worth an explicit warning
  // pointing at the override that can pin a tighter scope or turn it off.
  if (domain === appRegistrable) {
    warnings.push(
      `The session cookie now spans ${domain} and EVERY subdomain under it. ` +
        "Keep untrusted apps (status pages, third-party-hosted subdomains) " +
        "off this domain, or set BETTER_AUTH_COOKIE_DOMAIN to a narrower " +
        "scope (or `none` to keep the cookie host-only).",
    );
  }

  // useSecureCookies follows the API's scheme. An https API issues a
  // `__Secure-` cookie the browser refuses to send over plain http — so an
  // http dashboard would never see the session this domain exists to share.
  if (
    input.apiUrl?.startsWith("https://") &&
    input.appUrl?.startsWith("http://")
  ) {
    warnings.push(
      `API_URL is https but APP_URL is plain http — the session cookie is ` +
        `Secure and browsers will not send it to ${appHost} over http, so ` +
        "sharing a cookie domain cannot make the dashboard see a session. " +
        "Serve the dashboard over https.",
    );
  }

  return { kind: "shared", domain, source: "derived", warnings };
};
