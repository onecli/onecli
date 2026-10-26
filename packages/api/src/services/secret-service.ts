import { db, Prisma } from "@onecli/db";
import { getCrypto } from "../providers";
import { ServiceError } from "./errors";
import { attachLlmKeyToKeylessAgents } from "./llm-autoattach-service";
import { isLlmProviderId } from "../llm/registry";
import type { ResourceScope } from "./resource-scope";
import { scopeWhere, scopeCreate, scopeOwnership } from "./resource-scope";
import {
  detectAnthropicAuthMode,
  detectOpenaiAuthMode,
  isHeaderInjection,
  isParamInjection,
  isPathInjection,
  isPathRegexInjection,
  isPathSafeValue,
  isPathTemplateInjection,
  parseLocalMetadata,
  parseOpenaiAuthJson,
  parseOpenaiOAuthJson,
  type CreateSecretInput,
  type UpdateSecretInput,
} from "../validations/secret";

const normalizeOpenaiValue = (
  raw: string,
): { value: string; hostPattern: string } => {
  let value = raw;
  const authJson = parseOpenaiAuthJson(value);
  if (authJson?.mode === "api-key" && authJson.apiKey) {
    value = authJson.apiKey;
  }
  const hostPattern =
    detectOpenaiAuthMode(value) === "oauth" ? "chatgpt.com" : "api.openai.com";
  return { value, hostPattern };
};

// Provider names, not credential kinds: an `anthropic` secret is a Console
// API key OR a Claude subscription token (metadata.authMode tells which), the
// same way an `openai` secret is an API key or Codex OAuth.
const SECRET_TYPE_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "opencode-go": "OpenCode Go",
  openrouter: "OpenRouter",
  local: "Local (OpenAI-compatible)",
  generic: "Custom",
};

/** A `local` provider's host pattern: its base URL's hostname, always derived,
 *  never taken from the client (the SSRF note in `llm/types.ts`). */
const hostnameOf = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    throw new ServiceError("BAD_REQUEST", "Base URL must be a valid URL");
  }
};

/** The `local` secret's metadata: just its base URL. */
const localMetadata = (baseUrl: string): Prisma.InputJsonValue =>
  ({ baseUrl }) as Prisma.InputJsonValue;

const buildPreview = (plaintext: string): string => {
  if (plaintext.length <= 8) return "•".repeat(plaintext.length);
  return `${plaintext.slice(0, 4)}${"•".repeat(8)}${plaintext.slice(-4)}`;
};

const buildInjectionConfig = (
  config: CreateSecretInput["injectionConfig"],
): Prisma.InputJsonValue | typeof Prisma.JsonNull => {
  if (!config) return Prisma.JsonNull;
  if (isParamInjection(config)) {
    return {
      paramName: config.paramName.trim(),
      paramFormat: config.paramFormat?.trim() || "{value}",
    } as Prisma.InputJsonValue;
  }
  if (isHeaderInjection(config)) {
    return {
      headerName: config.headerName.trim(),
      valueFormat: config.valueFormat?.trim() || "{value}",
    } as Prisma.InputJsonValue;
  }
  if (isPathTemplateInjection(config)) {
    return {
      pathTemplate: config.pathTemplate.trim(),
    } as Prisma.InputJsonValue;
  }
  if (isPathRegexInjection(config)) {
    return {
      pathRegex: config.pathRegex.trim(),
      pathReplacement: config.pathReplacement.trim(),
    } as Prisma.InputJsonValue;
  }
  return Prisma.JsonNull;
};

// A path-injected secret is substituted into the URL path verbatim, so an inline
// value containing a path-structural char would reshape the request. 1Password
// values are resolved at request time and guarded by the gateway, so only inline
// values are checked here; the gateway's `is_path_safe` is the authoritative guard.
const assertPathValueSafe = (
  config: CreateSecretInput["injectionConfig"],
  valueSource: string | undefined,
  value: string | undefined,
): void => {
  if (
    isPathInjection(config) &&
    valueSource !== "onepassword" &&
    value &&
    !isPathSafeValue(value.trim())
  ) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Secret value can't contain / ? # % whitespace or control characters when injected into the URL path",
    );
  }
};

const buildMetadata = (
  type: string,
  value: string,
  baseUrl?: string,
): Prisma.InputJsonValue | typeof Prisma.JsonNull => {
  if (type === "anthropic") {
    return {
      authMode: detectAnthropicAuthMode(value) ?? "api-key",
    } as Prisma.InputJsonValue;
  }
  if (type === "openai") {
    const authMode = detectOpenaiAuthMode(value);
    const parsed = authMode === "oauth" ? parseOpenaiOAuthJson(value) : null;
    return {
      authMode,
      ...(parsed ? { accountId: parsed.tokens.account_id ?? null } : {}),
    } as Prisma.InputJsonValue;
  }
  // `local` carries its base URL instead of an auth mode.
  if (type === "local" && baseUrl) return localMetadata(baseUrl);
  return Prisma.JsonNull;
};

const buildOnePasswordMetadata = (
  type: string,
  opDisplay: CreateSecretInput["opDisplay"],
  baseUrl?: string,
): Prisma.InputJsonValue | typeof Prisma.JsonNull => {
  const meta: Record<string, unknown> = {};
  // LLM keys resolved from 1Password are always API-key mode (no value to inspect, no OAuth).
  if (type === "anthropic" || type === "openai") meta.authMode = "api-key";
  if (type === "local" && baseUrl) meta.baseUrl = baseUrl;
  if (opDisplay) meta.opDisplay = opDisplay;
  return Object.keys(meta).length > 0
    ? (meta as Prisma.InputJsonValue)
    : Prisma.JsonNull;
};

export type { CreateSecretInput, UpdateSecretInput };

/** How far back the key-health signal looks — old failures age out, and the
 * window bounds the per-host log scan. */
const LAST_ERROR_WINDOW_DAYS = 7;

/** Provider statuses that indict the key itself: auth (401/403), payment
 * (402), limits (429). Anything else is the request's problem, not the
 * key's. */
const KEY_PROBLEM_STATUSES = new Set([401, 402, 403, 429]);

/** The calls whose status speaks for the KEY: inference and the model list.
 * Agent runtimes also poll side endpoints with the same key (Claude Code
 * calls Anthropic's `/api/oauth/usage` at every boot), and providers refuse
 * those with 403/429 for perfectly good keys, so they must never brand one.
 * Path prefixes, so query strings and sub-paths (`/v1/messages/count_tokens`)
 * still count. `/backend-api/codex/` is the inference path of an OAuth-mode
 * OpenAI key (Codex signed in with ChatGPT, stored under `chatgpt.com`). */
const KEY_HEALTH_PATH_PREFIXES = [
  "/v1/messages",
  "/v1/models",
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/completions",
  "/v1/embeddings",
  "/backend-api/codex/",
] as const;
const keyHealthPathWhere = {
  OR: KEY_HEALTH_PATH_PREFIXES.map((prefix) => ({
    path: { startsWith: prefix },
  })),
};

export const listSecrets = async (scope: ResourceScope) => {
  const secrets = await db.secret.findMany({
    where: scopeWhere(scope),
    select: {
      id: true,
      name: true,
      type: true,
      valueSource: true,
      opRef: true,
      hostPattern: true,
      pathPattern: true,
      injectionConfig: true,
      metadata: true,
      scope: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  // The key's recent health, from the gateway's request log: for each LLM
  // key's host, the latest injected upstream call within the recency window.
  // Only statuses that indict the KEY itself brand it (auth, payment,
  // limits) — a plain 400 is the request's fault, not the key's. A failure
  // is only surfaced while it is the most recent word — one success
  // afterwards clears it, and silence ages out with the window (which also
  // bounds the [workspaceId, createdAt] index walk when a host has little
  // or no traffic). Workspace-scoped logs only, so an org-scoped key shows
  // health for THIS workspace's traffic.
  const workspaceId = scope.workspaceId;
  const healthWindowStart = new Date(
    Date.now() - LAST_ERROR_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  // Wildcard patterns can never match the equality lookup below — skip them
  // rather than issue a guaranteed-empty query per list call. LIKE
  // metacharacters are skipped too: Prisma's insensitive/startsWith filters
  // compile to ILIKE without escaping the value, so a stored `%`/`_` would
  // turn the member-editable hostPattern into a pattern match against other
  // hosts' rows. And the fan-out is capped: hostPattern is member-editable,
  // so distinct-host cardinality is member-controlled — canonical setups
  // have at most a few LLM hosts, and hosts past the cap simply show no
  // badge rather than amplifying the per-host window walk.
  const MAX_HEALTH_HOSTS = 20;
  const llmHosts = [
    ...new Set(
      secrets
        .filter((s) => s.type !== "generic")
        .map((s) => s.hostPattern)
        .filter((host) => Boolean(host) && !/[*%_\\]/.test(host)),
    ),
  ].slice(0, MAX_HEALTH_HOSTS);
  const lastErrorByHost = new Map<
    string,
    { status: number; at: Date } | null
  >();
  if (workspaceId && llmHosts.length > 0) {
    await Promise.all(
      llmHosts.map(async (host) => {
        // hostPattern is typically bare ("api.anthropic.com") while the log
        // stores the CONNECT authority verbatim — usually "host:443", but the
        // port varies and the case is whatever the client sent. Match any
        // port, case-insensitively (house precedent for this column:
        // request-log-service.ts).
        const hostWhere = {
          OR: [
            { host: { equals: host, mode: "insensitive" as const } },
            {
              host: { startsWith: `${host}:`, mode: "insensitive" as const },
            },
          ],
        };
        // Health is decoration on the list — a failed probe degrades to "no
        // badge" for its host, never to a failed GET /v1/secrets. Only calls
        // whose answer is about the key count (see KEY_HEALTH_PATH_PREFIXES).
        const latest = await db.requestLog
          .findFirst({
            where: {
              workspaceId,
              injectionCount: { gt: 0 },
              createdAt: { gte: healthWindowStart },
              AND: [hostWhere, keyHealthPathWhere],
            },
            orderBy: { createdAt: "desc" },
            select: { status: true, createdAt: true },
          })
          .catch(() => null);
        lastErrorByHost.set(
          host,
          latest && KEY_PROBLEM_STATUSES.has(latest.status)
            ? { status: latest.status, at: latest.createdAt }
            : null,
        );
      }),
    );
  }

  return secrets.map((s) => {
    // LLM keys only, per the published contract — a generic secret that
    // happens to share an LLM host must not inherit that traffic's badge.
    const hostError =
      s.type !== "generic"
        ? (lastErrorByHost.get(s.hostPattern) ?? null)
        : null;
    // Health is per HOST, so a failure logged before the key's last write
    // (creation, a new value, or any other edit) may belong to whatever key
    // served the host before: a fresh or rotated key starts clean instead of
    // inheriting its predecessor's "Key rejected". A real failure of THIS key
    // re-brands it on its next call.
    return {
      ...s,
      typeLabel: SECRET_TYPE_LABELS[s.type] ?? s.type,
      lastError: hostError && hostError.at >= s.updatedAt ? hostError : null,
    };
  });
};

/**
 * Hand a newly created WORKSPACE LLM key to the agents that can reach no key
 * at all (`llm-autoattach-service`), applied to BOTH creation arms (inline
 * and 1Password). A second key would re-point an agent's provider, drop its
 * chosen model, and respawn its sandbox, so an agent that has one is skipped.
 *
 * A CUSTOM (generic) secret is granted to no agent: the user picks who gets
 * it (the workspace's "choose agents" window, or the agent page that created
 * it, which attaches it to that agent explicitly).
 *
 * Workspace scope only. An ORG-level secret is reachable by every workspace in
 * the org, and quietly granting it across all of them is a widening nobody
 * asked for; org secrets stay an explicit attach.
 *
 * Best-effort by contract: the secret is already created, and a convenience
 * grant must never turn that into a failed request.
 */
const attachNewLlmKey = async (
  scope: ResourceScope,
  secret: { id: string; type: string },
  userId: string | null,
): Promise<string[]> => {
  if (!scope.workspaceId || !isLlmProviderId(secret.type)) return [];
  const { agentIds } = await attachLlmKeyToKeylessAgents(
    scope.workspaceId,
    secret.id,
    userId,
  ).catch(() => ({ agentIds: [] as string[] }));
  return agentIds;
};

export const createSecret = async (
  scope: ResourceScope,
  input: CreateSecretInput,
  /** Who to record as the grantor of an auto-attached LLM key grant. */
  userId: string | null = null,
) => {
  const name = input.name.trim();
  if (!name || name.length > 255) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Name must be between 1 and 255 characters",
    );
  }

  let hostPattern = input.hostPattern.trim();
  if (!hostPattern)
    throw new ServiceError("BAD_REQUEST", "Host pattern is required");

  if (input.type === "generic") {
    const config = input.injectionConfig;
    const hasHeader = isHeaderInjection(config) && config.headerName.trim();
    const hasParam = isParamInjection(config) && config.paramName.trim();
    const hasPath = isPathInjection(config);
    if (!hasHeader && !hasParam && !hasPath) {
      throw new ServiceError(
        "BAD_REQUEST",
        "Header name, parameter name, or URL path template is required for generic secrets",
      );
    }
    assertPathValueSafe(config, input.valueSource, input.value);
  }

  // `local`: the base URL is the source of truth. The host pattern is DERIVED
  // from it (never trusted from input — a client-supplied host would be a
  // credential-exfiltration primitive), and the path is unconstrained.
  const baseUrl = input.baseUrl?.trim();
  if (input.type === "local") {
    if (!baseUrl)
      throw new ServiceError(
        "BAD_REQUEST",
        "Base URL is required for local providers",
      );
    hostPattern = hostnameOf(baseUrl);
  }

  const pathPattern =
    input.type === "local" ? null : input.pathPattern?.trim() || null;
  const injectionConfig =
    input.type === "generic"
      ? buildInjectionConfig(input.injectionConfig)
      : Prisma.JsonNull;

  // Default to "inline" so existing callers and API clients that omit
  // valueSource keep storing the value in Postgres exactly as before.
  const valueSource = input.valueSource ?? "inline";

  // ── Value resolved from 1Password at request time (nothing stored in PG) ──
  if (valueSource === "onepassword") {
    // 1Password connections are per-workspace: the gateway resolves op:// refs via
    // the requesting agent's workspace connection. An org-scoped secret
    // has no single workspace, so its value would silently fail to resolve —
    // reject it here instead of creating a secret that can never inject.
    if (!scope.workspaceId) {
      throw new ServiceError(
        "BAD_REQUEST",
        "1Password is only available for workspace-scoped secrets",
      );
    }
    if (!input.opRef) {
      throw new ServiceError("BAD_REQUEST", "Select a 1Password field");
    }
    // LLM keys from 1Password are treated as plain API keys on their fixed host.
    if (input.type === "anthropic") hostPattern = "api.anthropic.com";
    if (input.type === "openai") hostPattern = "api.openai.com";
    if (input.type === "opencode-go") hostPattern = "opencode.ai";
    if (input.type === "openrouter") hostPattern = "openrouter.ai";

    const opSecret = await db.secret.create({
      data: {
        name,
        type: input.type,
        valueSource: "onepassword",
        encryptedValue: null,
        opRef: input.opRef,
        hostPattern,
        pathPattern,
        injectionConfig,
        metadata: buildOnePasswordMetadata(
          input.type,
          input.opDisplay,
          baseUrl,
        ),
        ...scopeCreate(scope),
      },
      select: {
        id: true,
        name: true,
        type: true,
        valueSource: true,
        opRef: true,
        hostPattern: true,
        pathPattern: true,
        createdAt: true,
      },
    });

    return {
      ...opSecret,
      attachedAgents: await attachNewLlmKey(scope, opSecret, userId),
    };
  }

  // ── Inline value (encrypted at rest) ──
  let value = (input.value ?? "").trim();
  // A `local` server may run keyless: an empty value is stored as no value at
  // all (encryptedValue null), so the gateway injects nothing and the catalog
  // is still listed without auth.
  if (!value && input.type !== "local")
    throw new ServiceError("BAD_REQUEST", "Secret value is required");

  if (input.type === "openai") {
    const normalized = normalizeOpenaiValue(value);
    value = normalized.value;
    hostPattern = normalized.hostPattern;
  }

  // Pay-your-own-upstream OpenAI-compatible keys inject on their own fixed
  // host; the gateway has no host knowledge for these types, so the stored
  // hostPattern is what routes the credential. Forced here, never trusted
  // from input (the SSRF note in `llm/types.ts`).
  if (input.type === "opencode-go") hostPattern = "opencode.ai";
  if (input.type === "openrouter") hostPattern = "openrouter.ai";

  const secret = await db.secret.create({
    data: {
      name,
      type: input.type,
      valueSource: "inline",
      encryptedValue: value ? await getCrypto().encrypt(value) : null,
      hostPattern,
      pathPattern,
      injectionConfig,
      metadata: buildMetadata(input.type, value, baseUrl),
      ...scopeCreate(scope),
    },
    select: {
      id: true,
      name: true,
      type: true,
      valueSource: true,
      opRef: true,
      hostPattern: true,
      pathPattern: true,
      createdAt: true,
    },
  });

  return {
    ...secret,
    ...(value ? { preview: buildPreview(value) } : {}),
    attachedAgents: await attachNewLlmKey(scope, secret, userId),
  };
};

export const deleteSecret = async (scope: ResourceScope, secretId: string) => {
  const secret = await db.secret.findFirst({
    where: scopeOwnership(scope, secretId),
    select: { id: true },
  });

  if (!secret) throw new ServiceError("NOT_FOUND", "Secret not found");

  await db.secret.delete({ where: { id: secretId } });
};

export const updateSecret = async (
  scope: ResourceScope,
  secretId: string,
  input: UpdateSecretInput,
) => {
  const secret = await db.secret.findFirst({
    where: scopeOwnership(scope, secretId),
    select: { id: true, type: true, metadata: true },
  });

  if (!secret) throw new ServiceError("NOT_FOUND", "Secret not found");

  const data: Record<string, unknown> = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new ServiceError("BAD_REQUEST", "Name is required");
    data.name = name;
  }

  // `local`: the base URL (new, or the existing one when only the value
  // changes) determines both the stored host pattern and the metadata. Handled
  // once, up front, so the value arm and a baseUrl-only update agree.
  if (secret.type === "local") {
    const baseUrl = input.baseUrl?.trim();
    if (input.baseUrl !== undefined && !baseUrl)
      throw new ServiceError("BAD_REQUEST", "Base URL is required");
    const resolved = baseUrl ?? parseLocalMetadata(secret.metadata)?.baseUrl;
    if (!resolved)
      throw new ServiceError(
        "BAD_REQUEST",
        "Base URL is required for local providers",
      );
    data.hostPattern = hostnameOf(resolved);
    data.pathPattern = null;
    data.metadata = localMetadata(resolved);
  }

  if (input.valueSource === "onepassword") {
    // Switch to / update a value resolved from 1Password. Per-workspace only, as in
    // createSecret: the gateway resolves op:// refs via the agent's workspace
    // connection, so org scope has no connection to resolve through.
    if (!scope.workspaceId) {
      throw new ServiceError(
        "BAD_REQUEST",
        "1Password is only available for workspace-scoped secrets",
      );
    }
    if (!input.opRef)
      throw new ServiceError("BAD_REQUEST", "Select a 1Password field");
    data.valueSource = "onepassword";
    data.encryptedValue = null;
    data.opRef = input.opRef;
    if (secret.type === "anthropic") data.hostPattern = "api.anthropic.com";
    if (secret.type === "openai") data.hostPattern = "api.openai.com";
    if (secret.type === "opencode-go") data.hostPattern = "opencode.ai";
    if (secret.type === "openrouter") data.hostPattern = "openrouter.ai";
    // `local`'s metadata (its base URL) was set above and must survive.
    if (secret.type !== "local")
      data.metadata = buildOnePasswordMetadata(secret.type, input.opDisplay);
  } else if (input.value !== undefined) {
    let value = input.value.trim();
    // `local` may clear its key to empty (a keyless server); every other type
    // still needs a value.
    if (!value && secret.type !== "local")
      throw new ServiceError("BAD_REQUEST", "Secret value is required");

    if (secret.type === "openai") {
      const normalized = normalizeOpenaiValue(value);
      value = normalized.value;
      data.hostPattern = normalized.hostPattern;
    }
    if (secret.type === "opencode-go") data.hostPattern = "opencode.ai";
    if (secret.type === "openrouter") data.hostPattern = "openrouter.ai";

    data.valueSource = "inline";
    // An empty `local` value is stored as NO value, so the gateway injects
    // nothing; the base-URL metadata set above still stands.
    data.encryptedValue = value ? await getCrypto().encrypt(value) : null;
    data.opRef = null;

    if (secret.type === "anthropic" || secret.type === "openai") {
      data.metadata = buildMetadata(secret.type, value);
    }
  }

  // A typed LLM key injects only on its provider's fixed host, so a PATCH must
  // never re-point it — the gateway injects on whatever host is stored, and a
  // client-supplied host here would be a key-exfiltration primitive. The create
  // path already refuses input for these; this is the update half, and it runs
  // AFTER the per-type forcing above so `input.hostPattern` can never win.
  if (input.hostPattern !== undefined && !isLlmProviderId(secret.type)) {
    const hostPattern = input.hostPattern.trim();
    if (!hostPattern)
      throw new ServiceError("BAD_REQUEST", "Host pattern is required");
    data.hostPattern = hostPattern;
  }

  // `local`'s path pattern is always null (its base URL carries the path).
  if (input.pathPattern !== undefined && secret.type !== "local") {
    data.pathPattern = input.pathPattern?.trim() || null;
  }

  if (input.injectionConfig !== undefined && secret.type === "generic") {
    data.injectionConfig = buildInjectionConfig(input.injectionConfig);
    assertPathValueSafe(input.injectionConfig, input.valueSource, input.value);
  }

  if (Object.keys(data).length === 0) {
    throw new ServiceError("BAD_REQUEST", "No fields to update");
  }

  await db.secret.update({ where: { id: secretId }, data });
};
