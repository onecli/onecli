import { db } from "@onecli/db";
import { agentProxyAddress } from "../lib/public-origins";
import { loadCaCertificate } from "../lib/gateway-ca";
import {
  parseAnthropicMetadata,
  parseOpenaiMetadata,
} from "../validations/secret";
import { buildCodexOAuthStub } from "../lib/codex-stubs";
import { getCrypto } from "../providers";
import {
  findInjectableSecretOfType,
  injectableSecretWhere,
} from "./injectable-secrets";
import {
  resolveAgentLlmCredential,
  type ResolvedLlmCredential,
} from "./llm-credential-service";

// Moved to `injectable-secrets` so this module and `llm-credential-service`
// can both use them without importing each other. Re-exported because the
// container-config route has always exposed them from here.
export { findInjectableSecretOfType, injectableSecretWhere };

/**
 * WHICH agent `GET /v1/container-config` hands out. An explicit `agent=` is
 * looked up as-is. Omission is the legacy arm: pre-v2 workspaces carry a
 * deprecated default agent (`Agent.isDefault`, never written anymore), and
 * resolving it keeps their already-configured unpinned machines working.
 * Everyone else gets a distinguishable miss — the route tells the caller to
 * pass an agent (AGENT_REQUIRED) or to create one (NO_AGENTS). Nothing is
 * EVER created here: the old arm minted a "Default Agent" with a live proxy
 * token nobody asked for.
 *
 * The hosted/runner plane never calls this — it resolves its agent off the
 * Sandbox row and passes it to `buildContainerConfig` explicitly (§5.1).
 */
export type ContainerAgentResolution =
  | { outcome: "resolved"; agent: { id: string; accessToken: string } }
  | { outcome: "identifier-not-found" }
  | { outcome: "no-legacy-default"; hasAgents: boolean };

export const resolveContainerConfigAgent = async (
  workspaceId: string,
  agentIdentifier?: string,
): Promise<ContainerAgentResolution> => {
  if (agentIdentifier) {
    const agent = await db.agent.findFirst({
      where: { workspaceId, identifier: agentIdentifier },
      select: { id: true, accessToken: true },
    });
    return agent
      ? { outcome: "resolved", agent }
      : { outcome: "identifier-not-found" };
  }

  // Oldest-first because the schema never enforced single-default — only the
  // retired set-default transaction did — so a pathological pre-v2 workspace
  // with several flagged rows resolves deterministically, not by Postgres's
  // whim.
  const legacyDefault = await db.agent.findFirst({
    where: { workspaceId, isDefault: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, accessToken: true },
  });
  if (legacyDefault) return { outcome: "resolved", agent: legacyDefault };

  const hasAgents = (await db.agent.count({ where: { workspaceId } })) > 0;
  return { outcome: "no-legacy-default", hasAgents };
};

/**
 * The zero-credential bootstrap builder: everything a container needs to run
 * behind the gateway — proxy env with the agent's proxy token, the gateway CA,
 * PLACEHOLDER credential env/stubs (the gateway splices real values at the
 * wire), and provision-time warnings. Extracted from the route so the control
 * plane can compose spawn payloads server-side (§5.1: runners never hold a
 * user credential; the agent is always resolved explicitly by the caller —
 * the omission fallback above is the route's arm alone).
 */

export const CA_CONTAINER_PATH = "/tmp/onecli-gateway-ca.pem";
// Stays on the EPHEMERAL rootfs on purpose, even though ~ is now durable
// (/workspace/.home): spawn files may never target the durable home (the
// manager's validations refuse /workspace/** — a prior spawn could pre-plant
// a symlink for root's `install` to follow), and the stub is a per-spawn
// placeholder the gateway splices over anyway. CODEX_HOME (env) pins it.
const CODEX_HOME_CONTAINER_PATH = "/home/node/.codex";

export interface ContainerConfig {
  env: Record<string, string>;
  caCertificate: string;
  caCertificateContainerPath: string;
  credentialStubs?: Array<{ containerPath: string; content: string }>;
  warnings?: string[];
}

export type ContainerConfigResult =
  | {
      ok: true;
      config: ContainerConfig;
      /**
       * Which LLM key this agent would actually be handed, or null for none.
       *
       * Reported rather than acted on, because the two callers want opposite
       * things from the same answer. The hosted start path REFUSES on null —
       * a sandbox with no injectable key can only boot and 401 (door 2 of the
       * §3.2 check). The BYO container-config route does not: a developer's
       * local container running on their own key is a legitimate, long-standing
       * use, and it keeps the warning it has always had.
       */
      llmCredential: ResolvedLlmCredential | null;
    }
  | { ok: false; reason: "ca_unavailable" };

export interface BuildContainerConfigInput {
  /** The agent, resolved EXPLICITLY by the caller — never inferred here. */
  agent: { id: string; accessToken: string };
  workspaceId: string;
  organizationId: string;
  /** Dashboard origin for warning links; empty when composed server-side. */
  origin?: string;
}

export const buildContainerConfig = async ({
  agent,
  workspaceId,
  organizationId,
  origin,
}: BuildContainerConfigInput): Promise<ContainerConfigResult> => {
  const gatewayUrl = `http://x:${agent.accessToken}@${agentProxyAddress()}`;

  const caCertificate = loadCaCertificate();
  if (!caCertificate) return { ok: false, reason: "ca_unavailable" };

  // Which credentials this agent can actually be handed — the same answer
  // the gateway reaches at connect: exactly what its published rules grant,
  // which since step 10 is the ONLY source (the legacy per-agent grant tables
  // are frozen and unread, so reading them here would miss every credential
  // granted the normal way — and hand the container an API key for what is
  // actually an OAuth token).
  const injectableSecrets = await injectableSecretWhere(
    agent,
    workspaceId,
    organizationId,
  );

  // Detect auth mode from the agent's Anthropic secret metadata. OAuth
  // tokens need CLAUDE_CODE_OAUTH_TOKEN so the SDK does the token exchange;
  // API keys need ANTHROPIC_API_KEY. Defaults to api-key for legacy secrets
  // without metadata.
  const anthropicSecret = await findInjectableSecretOfType(
    injectableSecrets,
    "anthropic",
    { metadata: true, encryptedValue: true },
  );

  const meta = parseAnthropicMetadata(anthropicSecret?.metadata);

  // Which LLM key would actually serve this agent — including the platform
  // trial credential when the pool has no key of its own (cloud-only; scope
  // "platform"). Resolved BEFORE the env block so the advertisement below can
  // account for it. Reuses the `where` computed above — building it costs
  // three queries, and this is the same fenced selection by construction.
  const llmCredential = await resolveAgentLlmCredential(
    { id: agent.id, workspaceId },
    organizationId,
    injectableSecrets,
  );
  const platformCredit = llmCredential?.scope === "platform";

  // Only when an Anthropic key is actually injectable.
  //
  // This used to be unconditional, and that was a bug in both directions. In a
  // hosted sandbox, harnesses choose a provider by which `*_API_KEY` variable
  // is set, so an agent granted only an OpenAI key was handed a fake Anthropic
  // one, picked Anthropic, and 401'd forever. On the BYO path it was worse
  // than useless: the warning beneath says "the agent will use its own API key
  // if available", while setting the variable to "placeholder" is precisely
  // what SHADOWS the user's own key.
  //
  // The platform trial credential is the deliberate third arm: no secret in
  // the pool, but the GATEWAY will inject the platform's Anthropic key — so
  // the placeholder is advertised (harnesses pick Claude), and the gateway
  // splices the real key at the wire exactly as for a user secret. The
  // container still never sees a real value.
  const authEnv: Record<string, string> = anthropicSecret
    ? meta?.authMode === "oauth"
      ? { CLAUDE_CODE_OAUTH_TOKEN: "placeholder" }
      : { ANTHROPIC_API_KEY: "placeholder" }
    : platformCredit
      ? { ANTHROPIC_API_KEY: "placeholder" }
      : {};

  // Detect OpenAI auth mode for Codex container support.
  const openaiSecret = await findInjectableSecretOfType(
    injectableSecrets,
    "openai",
    { metadata: true },
  );

  const openaiMeta = parseOpenaiMetadata(openaiSecret?.metadata);

  const openaiEnv: Record<string, string> = {};
  const credentialStubs: Array<{ containerPath: string; content: string }> = [];

  if (openaiSecret) {
    if (openaiMeta?.authMode === "oauth") {
      openaiEnv.CODEX_HOME = CODEX_HOME_CONTAINER_PATH;
      credentialStubs.push({
        containerPath: `${CODEX_HOME_CONTAINER_PATH}/auth.json`,
        content: buildCodexOAuthStub(),
      });
    } else {
      openaiEnv.OPENAI_API_KEY = "placeholder";
    }
  }

  const warnings: string[] = [];
  if (!anthropicSecret && !platformCredit) {
    warnings.push(
      "No Anthropic credentials configured. The agent will use its own API key if available. Add one at " +
        (origin ?? "") +
        "/secrets",
    );
  } else if (anthropicSecret?.encryptedValue) {
    // 1Password-sourced secrets have no stored value to decrypt — the
    // gateway resolves them live, so the decryptability check doesn't apply.
    try {
      await getCrypto().decrypt(anthropicSecret.encryptedValue);
    } catch {
      warnings.push(
        "Anthropic credentials exist but cannot be decrypted by the gateway (encryption format mismatch). Re-create the secret to fix this.",
      );
    }
  }

  return {
    ok: true,
    llmCredential,
    config: {
      env: {
        // Proxy -- uppercase + lowercase (some tools only check one)
        HTTPS_PROXY: gatewayUrl,
        HTTP_PROXY: gatewayUrl,
        https_proxy: gatewayUrl,
        http_proxy: gatewayUrl,
        // Node.js
        NODE_EXTRA_CA_CERTS: CA_CONTAINER_PATH,
        NODE_USE_ENV_PROXY: "1",
        // Everything else that speaks TLS. Inside a gateway-only container
        // this CA is the only certificate that matters, and setting the
        // variables HERE (rather than exporting them from an entrypoint)
        // makes them part of the container's environment — so a tool started
        // outside the supervisor's process tree, or a `docker exec` session,
        // trusts the gateway too instead of failing verification.
        SSL_CERT_FILE: CA_CONTAINER_PATH,
        CURL_CA_BUNDLE: CA_CONTAINER_PATH,
        REQUESTS_CA_BUNDLE: CA_CONTAINER_PATH,
        // Git
        GIT_TERMINAL_PROMPT: "0",
        GIT_HTTP_PROXY_AUTHMETHOD: "basic",
        GIT_SSL_CAINFO: CA_CONTAINER_PATH,
        ...authEnv,
        ...openaiEnv,
      },
      caCertificate,
      caCertificateContainerPath: CA_CONTAINER_PATH,
      ...(credentialStubs.length > 0 && { credentialStubs }),
      ...(warnings.length > 0 && { warnings }),
    },
  };
};
