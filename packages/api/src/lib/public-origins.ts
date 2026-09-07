/**
 * The one resolver for "what addresses does this deployment advertise?".
 *
 * One canonical input — `ONECLI_EXTERNAL_URL`, the URL a person opens OneCLI
 * at — and two derivation modes decided by its scheme:
 *
 *   http  ⇒ **ports mode**:  api/gateway live on the same host, own ports
 *   https ⇒ **proxy mode**:  one origin; a path-routing proxy serves
 *                            `/v1` + `/auth` (api) and `/gw/*` (gateway)
 *
 * `APP_URL` / `NEXT_PUBLIC_APP_URL` are permanent read-aliases; `API_URL` /
 * `GATEWAY_API_URL` are advanced per-origin overrides (split-host installs and
 * the cloud task defs). Nothing on the publish plane (`ONECLI_BIND_HOST`,
 * ports) feeds a URL — except the warned legacy bind seed kept for one release
 * so compose-pull upgraders keep their pre-refactor behavior.
 *
 * Design rules this module must not break:
 *
 * - **Leaf module.** No imports from `lib/env.ts` (drags edition/entitlement
 *   graphs), no logger, no db. Web client code imports this file; anything
 *   server-heavy here would land in browser chunks. Warnings are returned as
 *   data, callers log.
 * - **Literal dot reads.** Every env access is a literal dot member
 *   expression on the process env: Next.js can only inline `NEXT_PUBLIC_*`
 *   literals into client bundles (the browser fallback depends on it), and
 *   the hermetic-env scanner classifies only dot reads.
 * - **Call-time, uncached.** Consumers that need freezing already freeze
 *   (`getOnpremAuth` caches its product; the web layout is force-dynamic and
 *   per-request is the point). Tests stub env per case with no module dance.
 * - **Blank is unset.** The compose pass-through rows (`APP_URL: ${APP_URL:-}`)
 *   deliver empty strings into containers; every head uses
 *   {@link firstConfigured}, never `??`.
 */

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
export const HOST_PATTERN =
  /^(?:[A-Za-z0-9._~-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/** First env var with a non-empty value, ignoring surrounding whitespace. */
export const firstConfigured = (...values: (string | undefined)[]) => {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
};

/**
 * Validate an origin that reached us as data rather than as request headers —
 * a signed OAuth-state origin, an `ONECLI_TRUSTED_ORIGINS` entry.
 *
 * Returns the normalized `scheme://host[:port]`, or `undefined` for anything
 * that is not a well-formed http(s) origin (including non-strings). Same host
 * rules as `originFromHeaders`, so the two agree on what an origin may look
 * like, and `javascript:`/`data:` can never survive into a redirect.
 *
 * Fail-*soft* on purpose: a bad value falls through to the caller's next
 * fallback rather than stranding the user mid-connect.
 */
export const normalizeOrigin = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const match = /^(https?):\/\/(.+)$/i.exec(value.trim().replace(/\/+$/, ""));
  const [, scheme, host] = match ?? [];
  // `HOST_PATTERN` allows no `/`, `@` or `?`, so a path, query, or `user:pass@`
  // prefix lands in `host` and is rejected here rather than surviving into a
  // redirect — the greedy `.+` above exists to make that happen.
  if (!scheme || !host || !HOST_PATTERN.test(host)) return undefined;
  return `${scheme.toLowerCase()}://${host}`;
};

/** Everything the resolver reads, as data — the pure core never touches env. */
export interface PublicOriginsEnvBag {
  externalUrl?: string;
  appUrl?: string;
  nextPublicAppUrl?: string;
  apiUrl?: string;
  nextPublicApiUrl?: string;
  gatewayApiUrl?: string;
  nextPublicGatewayApiUrl?: string;
  bindHost?: string;
  appPort?: string;
  apiPort?: string;
  gatewayPort?: string;
  agentProxyAddress?: string;
  gatewayBaseUrl?: string;
}

export type OriginsMode = "ports" | "proxy";

export type OriginSource =
  | "set"
  | "alias"
  | "legacy-bind"
  | "derived"
  | "default";

export interface ResolvedOriginSource {
  source: OriginSource;
  /** The env var that decided it, when one did. */
  envVar?: string;
}

export interface ResolvedPublicOrigins {
  /** The canonical URL, defaults applied — never blank, no trailing slash. */
  external: string;
  mode: OriginsMode;
  /** The dashboard origin — always `external`. */
  app: string;
  api: string;
  /** Gateway HTTP origin; in proxy mode `external + "/gw"` (prefix-strip). */
  gateway: string;
  /** Scheme-less `host:port` handed to agent containers as CONNECT target. */
  agentProxyAddress: string;
  /**
   * Whether ANY head answered (canonical, alias, or legacy bind seed) — the
   * configured-vs-defaulted seam `configuredAppUrl()` exposes. When false,
   * callers may fall back to the request's own origin.
   */
  externalConfigured: boolean;
  sources: {
    external: ResolvedOriginSource;
    api: ResolvedOriginSource;
    gateway: ResolvedOriginSource;
    agentProxyAddress: ResolvedOriginSource;
  };
  /** Deprecations and conflicts, for the caller's logger. */
  warnings: string[];
}

/** A misconfigured NEW-name var — legacy names stay lenient by design. */
export class OriginConfigError extends Error {
  constructor(message: string, fixes: string[]) {
    super(fixes.length ? `${message} ${fixes.join(" ")}` : message);
    this.name = "OriginConfigError";
  }
}

const DEFAULT_APP_PORT = 10254;
const DEFAULT_GATEWAY_PORT = 10255;
const DEFAULT_API_PORT = 10256;
const DEFAULT_AGENT_PROXY_ADDRESS = "host.docker.internal:10255";

const portOrDefault = (raw: string | undefined, fallback: number): number => {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d{1,5}$/.test(trimmed)) return fallback;
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : fallback;
};

const stripTrailingSlashes = (value: string) => value.replace(/\/+$/, "");

/** `scheme://host[:port]` split; `host` keeps IPv6 brackets. */
const parseOrigin = (origin: string) =>
  /^(https?):\/\/(\[[^\]]+\]|[^:/]+)(?::(\d{1,5}))?$/.exec(origin);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

/*
 * ── Legacy compatibility ledger ─────────────────────────────────────────
 * Two classes of old-name support exist. Every class-(A) site carries the
 * grep-able marker "LEGACY(next-major)"; scripts/legacy-marker.test.mjs
 * enforces that the marker appears in exactly the ledgered files, so the
 * next-major cleanup is one grep away and cannot silently grow.
 *
 * (A) DELETE AT THE NEXT MAJOR:
 *   - legacyBindSeed() below (the TS resolver's warned bind seed)
 *   - apps/gateway/crates/context/src/lib.rs — seedable_bind_host + the
 *     LegacyBind arm and its main.rs warning
 *   - scripts/install.sh — bind_seeds_url + the display-derivation branch
 *   - docker/docker-compose.yml — the ONECLI_BIND_HOST environment rows
 *     (they exist only to feed the seed; the `ports:` publish lines stay)
 *   - apps/web/next.config.js — the API_DOMAIN/GATEWAY_API_DOMAIN build
 *     fallback, plus turbo.json's "API_DOMAIN"/"GATEWAY_API_DOMAIN" rows
 *     (JSON, no marker possible — listed here instead)
 *   - packages/infra/lib/api-server-stack.ts — the duplicate legacy
 *     GATEWAY_BASE_URL row (droppable once the resolver image is deployed
 *     everywhere; cloud-only file)
 *
 * (B) PERMANENT ALIASES — never delete (each costs one chain head, and
 *     removing them breaks cloud task defs and field .env files):
 *     APP_URL / NEXT_PUBLIC_APP_URL (external heads); API_URL /
 *     NEXT_PUBLIC_API_URL and GATEWAY_API_URL / NEXT_PUBLIC_GATEWAY_API_URL
 *     (per-origin overrides); GATEWAY_BASE_URL (agent-proxy read-alias);
 *     and routes/migrate-nanoclaw.ts's `ONECLI_URL=` file format (frozen
 *     field contract).
 */

/**
 * LEGACY(next-major): the warned bind seed. A non-loopback, non-wildcard
 * ONECLI_BIND_HOST used to seed the compose URL defaults; preserving it for
 * one release keeps compose-pull upgraders on their pre-refactor addresses.
 * Deleting this function (and the ledgered siblings above) is the whole
 * next-major cleanup on the TS side.
 */
const legacyBindSeed = (
  bindHost: string | undefined,
  appPort: number,
): { url: string; warning: string } | undefined => {
  const bind = firstConfigured(bindHost);
  if (!bind || LOOPBACK_HOSTS.has(bind) || WILDCARD_HOSTS.has(bind)) {
    return undefined;
  }
  const url = `http://${hostForUrl(bind)}:${appPort}`;
  return {
    url,
    warning:
      `ONECLI_BIND_HOST=${bind} is seeding the public URL (deprecated, ` +
      "removed next major). Pin it: add " +
      `ONECLI_EXTERNAL_URL=${url} to the .env beside docker-compose.yml.`,
  };
};

/** Bracket a bare IPv6 literal so it can carry a port. */
const hostForUrl = (host: string) =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

/**
 * Strict validation for the NEW names only. Legacy `APP_URL`-family values
 * keep today's lenient trim-and-pass-through — a value that has worked for an
 * existing install must keep working (`resolveCookieDomain` already warns on
 * unparseable input downstream).
 */
const validateExternalUrl = (raw: string): string => {
  const stripped = stripTrailingSlashes(raw.trim());
  if (!/^https?:\/\//i.test(stripped)) {
    throw new OriginConfigError(`ONECLI_EXTERNAL_URL="${raw}" has no scheme.`, [
      "Write http:// or https:// explicitly.",
      "(http means ports; https means a proxy.)",
    ]);
  }
  const normalized = normalizeOrigin(stripped);
  if (!normalized) {
    throw new OriginConfigError(
      `ONECLI_EXTERNAL_URL="${raw}" is not a plain origin.`,
      [
        "Use scheme://host[:port] with no path, query, or credentials.",
        "Subpath serving is unsupported; use a dedicated hostname or port.",
      ],
    );
  }
  const [, , host] = parseOrigin(normalized) ?? [];
  if (host && WILDCARD_HOSTS.has(host)) {
    throw new OriginConfigError(
      `ONECLI_EXTERNAL_URL="${raw}" names a bind address.`,
      [
        `Set ONECLI_BIND_HOST=${host} to control where ports publish,`,
        "and set ONECLI_EXTERNAL_URL to the address people browse to.",
      ],
    );
  }
  return normalized;
};

const validateAgentProxyAddress = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed.includes("://")) {
    throw new OriginConfigError(
      `ONECLI_AGENT_PROXY_ADDRESS="${raw}" carries a scheme.`,
      ["A scheme-less host:port is expected, e.g. gateway:10255."],
    );
  }
  if (!HOST_PATTERN.test(trimmed)) {
    throw new OriginConfigError(
      `ONECLI_AGENT_PROXY_ADDRESS="${raw}" is not a valid host:port.`,
      ["Use a plain host or host:port, e.g. 172.17.0.1:10255."],
    );
  }
  return trimmed;
};

/**
 * The pure core. Reads nothing; throws {@link OriginConfigError} only for
 * invalid NEW-name values; returns deprecation/conflict warnings as data.
 */
export const resolvePublicOrigins = (
  env: PublicOriginsEnvBag,
): ResolvedPublicOrigins => {
  const warnings: string[] = [];
  const appPort = portOrDefault(env.appPort, DEFAULT_APP_PORT);
  const apiPort = portOrDefault(env.apiPort, DEFAULT_API_PORT);
  const gatewayPort = portOrDefault(env.gatewayPort, DEFAULT_GATEWAY_PORT);

  // ── external ──────────────────────────────────────────────────────────
  const canonical = firstConfigured(env.externalUrl);
  const alias = firstConfigured(env.appUrl, env.nextPublicAppUrl);
  const aliasVar = firstConfigured(env.appUrl)
    ? "APP_URL"
    : "NEXT_PUBLIC_APP_URL";

  let external: string;
  let externalSource: ResolvedOriginSource;
  let externalConfigured = true;

  if (canonical) {
    external = validateExternalUrl(canonical);
    externalSource = { source: "set", envVar: "ONECLI_EXTERNAL_URL" };
    if (alias) {
      const strippedAlias = stripTrailingSlashes(alias);
      if ((normalizeOrigin(strippedAlias) ?? strippedAlias) !== external) {
        warnings.push(
          `ONECLI_EXTERNAL_URL (${external}) and ${aliasVar} (${strippedAlias}) ` +
            `disagree; ONECLI_EXTERNAL_URL wins. Remove the ${aliasVar} line ` +
            "unless it is an intentional override of a different origin.",
        );
      }
    }
  } else if (alias) {
    external = stripTrailingSlashes(alias);
    externalSource = { source: "alias", envVar: aliasVar };
  } else {
    const seeded = legacyBindSeed(env.bindHost, appPort);
    if (seeded) {
      external = seeded.url;
      externalSource = { source: "legacy-bind", envVar: "ONECLI_BIND_HOST" };
      warnings.push(seeded.warning);
    } else {
      external = `http://localhost:${appPort}`;
      externalSource = { source: "default" };
      externalConfigured = false;
    }
  }

  const mode: OriginsMode = external.startsWith("https://") ? "proxy" : "ports";
  const [, scheme = "http", host = "localhost"] = parseOrigin(external) ?? [];

  // ── api / gateway ─────────────────────────────────────────────────────
  //
  // Derivation from `external` applies only to the CANONICAL var (whose
  // documented contract is "http means ports, https means a proxy") and the
  // legacy bind seed (which replaced a compose default that seeded all three
  // URLs). A bare legacy `APP_URL` never feeds the api/gateway origins: its
  // frozen contract names the dashboard only — in a split deployment that
  // host serves no `/v1`, and existing installs rely on the header-origin
  // fallback that a derived answer would silently disable.
  const deriveFromExternal =
    externalSource.source === "set" || externalSource.source === "legacy-bind";

  // One rule for both service origins: override wins verbatim, else derive
  // from the external URL per mode, else the localhost default.
  const deriveOrigin = (
    override: string | undefined,
    overrideVar: string,
    fallbackVar: string,
    proxyValue: string,
    port: number,
  ): { value: string; source: ResolvedOriginSource } =>
    override
      ? {
          value: stripTrailingSlashes(override),
          source: {
            source: "set",
            envVar: firstConfigured(
              overrideVar === "API_URL" ? env.apiUrl : env.gatewayApiUrl,
            )
              ? overrideVar
              : fallbackVar,
          },
        }
      : {
          value: deriveFromExternal
            ? mode === "proxy"
              ? proxyValue
              : `${scheme}://${host}:${port}`
            : `http://localhost:${port}`,
          source: { source: deriveFromExternal ? "derived" : "default" },
        };

  const { value: api, source: apiSource } = deriveOrigin(
    firstConfigured(env.apiUrl, env.nextPublicApiUrl),
    "API_URL",
    "NEXT_PUBLIC_API_URL",
    external,
    apiPort,
  );
  const { value: gateway, source: gatewaySource } = deriveOrigin(
    firstConfigured(env.gatewayApiUrl, env.nextPublicGatewayApiUrl),
    "GATEWAY_API_URL",
    "NEXT_PUBLIC_GATEWAY_API_URL",
    `${external}/gw`,
    gatewayPort,
  );

  // ── agent proxy ───────────────────────────────────────────────────────
  const proxyNew = firstConfigured(env.agentProxyAddress);
  const proxyOld = firstConfigured(env.gatewayBaseUrl);
  let agentProxy: string;
  let agentProxySource: ResolvedOriginSource;
  if (proxyNew) {
    agentProxy = validateAgentProxyAddress(proxyNew);
    agentProxySource = { source: "set", envVar: "ONECLI_AGENT_PROXY_ADDRESS" };
  } else if (proxyOld) {
    // Lenient by design: field values like `gateway:10255` and
    // `<domain>:10255` (the cloud task defs) must keep working verbatim.
    agentProxy = proxyOld;
    agentProxySource = { source: "alias", envVar: "GATEWAY_BASE_URL" };
    warnings.push(
      "GATEWAY_BASE_URL is deprecated; rename the line to " +
        "ONECLI_AGENT_PROXY_ADDRESS (same value). The old name keeps working.",
    );
  } else {
    agentProxy = DEFAULT_AGENT_PROXY_ADDRESS;
    agentProxySource = { source: "default" };
  }

  return {
    external,
    mode,
    app: external,
    api,
    gateway,
    agentProxyAddress: agentProxy,
    externalConfigured,
    sources: {
      external: externalSource,
      api: apiSource,
      gateway: gatewaySource,
      agentProxyAddress: agentProxySource,
    },
    warnings,
  };
};

/** The loopback twin of an origin, when it has one (`localhost` ↔ `127.0.0.1`). */
const loopbackTwin = (origin: string): string | undefined => {
  const [, scheme, host, port] = parseOrigin(origin) ?? [];
  if (!scheme || !host) return undefined;
  const twinHost =
    host === "localhost"
      ? "127.0.0.1"
      : host === "127.0.0.1"
        ? "localhost"
        : undefined;
  if (!twinHost) return undefined;
  return `${scheme}://${twinHost}${port ? `:${port}` : ""}`;
};

const originHost = (origin: string) => parseOrigin(origin)?.[2];

export interface TrustedOrigins {
  origins: string[];
  warnings: string[];
}

/**
 * The browser origins the auth layer should trust: the dashboard origin, its
 * loopback twin (an operator typing 127.0.0.1 where the config says localhost
 * must not face an unexplainable 403), any operator-listed extras, and — when
 * the api lives on another host — the api origin and its twin too.
 */
export const buildTrustedOrigins = (
  resolved: ResolvedPublicOrigins,
  extraCsv?: string,
): TrustedOrigins => {
  const warnings: string[] = [];
  const origins = [resolved.app];
  const appTwin = loopbackTwin(resolved.app);
  if (appTwin) origins.push(appTwin);

  for (const entry of extraCsv?.split(",") ?? []) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const normalized = normalizeOrigin(trimmed);
    if (normalized) {
      origins.push(normalized);
    } else {
      warnings.push(
        `ONECLI_TRUSTED_ORIGINS entry "${trimmed}" is not a valid ` +
          "scheme://host[:port] origin; ignoring it.",
      );
    }
  }

  // Only a CONFIGURED api origin joins the set: a defaulted localhost api
  // beside a real app host is not a split deployment, just an alias-only
  // config — and better-auth already trusts its own baseURL origin.
  if (
    resolved.sources.api.source !== "default" &&
    originHost(resolved.api) !== originHost(resolved.app)
  ) {
    origins.push(resolved.api);
    const apiTwin = loopbackTwin(resolved.api);
    if (apiTwin) origins.push(apiTwin);
  }

  return { origins: [...new Set(origins)], warnings };
};

/**
 * An origin echoed back only when this deployment already trusts it —
 * `undefined` for every other value, malformed input included.
 *
 * The set is [`buildTrustedOrigins`]'s, read from the environment: the same
 * answer the auth layer enforces on sign-in, so a browser that may log in and
 * one that may call the API can never disagree. Two call sites need exactly
 * this question and must not drift apart — the api-server's credentialed CORS
 * allow-list, and `request-origin.ts`'s trusted-referer step.
 *
 * Fail-CLOSED, unlike [`normalizeOrigin`]'s other callers, which fall through
 * to a next-best answer: here there is no next-best. An unlisted origin gets
 * no `Access-Control-Allow-Origin` header at all, never a wildcard and never
 * itself reflected back — with `credentials: true`, reflecting an arbitrary
 * origin would make every site the user's browser visits an ambient caller of
 * this API. `SameSite=lax` does not cover the gap: it is SITE-scoped, so a
 * sibling subdomain (or another port of the same host) is same-site and the
 * session cookie rides along.
 */
export const trustedBrowserOrigin = (
  origin: string | null | undefined,
): string | undefined => {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return undefined;
  const { origins } = buildTrustedOrigins(
    resolveOriginsFromEnv(),
    process.env.ONECLI_TRUSTED_ORIGINS,
  );
  return origins.includes(normalized) ? normalized : undefined;
};

const sourceTag = ({ source, envVar }: ResolvedOriginSource) => {
  switch (source) {
    case "set":
      return `(set: ${envVar})`;
    case "alias":
      return `(alias: ${envVar})`;
    case "legacy-bind":
      return "(legacy bind seed)";
    case "derived":
      return "(derived)";
    case "default":
      return "(default)";
  }
};

/** One line per advertised address, tagged with where the value came from. */
export const formatOriginsBanner = (
  resolved: ResolvedPublicOrigins,
): string[] => [
  `public origins (mode: ${resolved.mode})`,
  `  external     ${resolved.external} ${sourceTag(resolved.sources.external)}`,
  `  api          ${resolved.api} ${sourceTag(resolved.sources.api)}`,
  `  gateway      ${resolved.gateway} ${sourceTag(resolved.sources.gateway)}`,
  `  agent proxy  ${resolved.agentProxyAddress} ${sourceTag(resolved.sources.agentProxyAddress)}`,
];

/**
 * The env wrapper. Every read is a literal dot access — load-bearing twice:
 * Next.js inlines `NEXT_PUBLIC_*` only as literal member expressions (the
 * browser fallback in client bundles depends on it), and the hermetic-env
 * scanner classifies only dot reads.
 */
const readEnvBag = (): PublicOriginsEnvBag => ({
  externalUrl: process.env.ONECLI_EXTERNAL_URL,
  appUrl: process.env.APP_URL,
  nextPublicAppUrl: process.env.NEXT_PUBLIC_APP_URL,
  apiUrl: process.env.API_URL,
  nextPublicApiUrl: process.env.NEXT_PUBLIC_API_URL,
  gatewayApiUrl: process.env.GATEWAY_API_URL,
  nextPublicGatewayApiUrl: process.env.NEXT_PUBLIC_GATEWAY_API_URL,
  bindHost: process.env.ONECLI_BIND_HOST,
  appPort: process.env.ONECLI_APP_PORT,
  apiPort: process.env.ONECLI_API_PORT,
  gatewayPort: process.env.ONECLI_GATEWAY_PORT,
  agentProxyAddress: process.env.ONECLI_AGENT_PROXY_ADDRESS,
  gatewayBaseUrl: process.env.GATEWAY_BASE_URL,
});

export const resolveOriginsFromEnv = (): ResolvedPublicOrigins =>
  resolvePublicOrigins(readEnvBag());

/** The dashboard origin — where a browser opens OneCLI. */
export const appOrigin = (): string => resolveOriginsFromEnv().app;

/** The api-server origin — OAuth redirect base, CLI api-host, /v1 calls. */
export const apiOrigin = (): string => resolveOriginsFromEnv().api;

/** The gateway HTTP origin (approvals, vault status) — NOT the CONNECT proxy. */
export const gatewayHttpOrigin = (): string => resolveOriginsFromEnv().gateway;

/** Scheme-less host:port agent containers use as their CONNECT proxy target. */
export const agentProxyAddress = (): string =>
  resolveOriginsFromEnv().agentProxyAddress;

/**
 * The public app URL the operator explicitly configured, or `undefined` when
 * they configured none.
 *
 * `undefined` is the whole point: it is what lets a call site say "…and if
 * nothing was configured, use the request origin instead". The legacy bind
 * seed counts as configured — it replaced a compose-seeded `APP_URL` that was
 * configured too.
 */
export const configuredAppUrl = (): string | undefined => {
  const resolved = resolveOriginsFromEnv();
  return resolved.externalConfigured ? resolved.app : undefined;
};

/**
 * The public **api-server** URL the operator explicitly configured — via
 * `API_URL`, or derived from a configured `ONECLI_EXTERNAL_URL` — or
 * `undefined` when nothing was configured, so callers can fall back to the
 * origin the request arrived on. A configured external URL answering here is
 * what pins OAuth redirect URIs without a separate `API_URL` line.
 */
export const configuredApiUrl = (): string | undefined => {
  const resolved = resolveOriginsFromEnv();
  return resolved.sources.api.source === "default" ? undefined : resolved.api;
};
