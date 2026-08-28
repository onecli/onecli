import { db, type Prisma } from "@onecli/db";
import { getCrypto } from "../providers";
import {
  getPlatformLlm,
  PLATFORM_LLM_SECRET_ID,
} from "../providers/platform-llm";
import {
  NO_MODEL_KEY_MESSAGE,
  type TurnErrorCode,
} from "../validations/conversation";
import {
  parseAnthropicMetadata,
  parseOpenaiMetadata,
} from "../validations/secret";
import {
  LLM_PROVIDER_IDS,
  isLlmProviderId,
  llmProvider,
} from "../llm/registry";
import type { LlmProviderId } from "../llm/types";
import { injectableSecretWhere } from "./injectable-secrets";

/**
 * Which LLM key an agent actually has, answered with the GATEWAY'S OWN
 * predicate (§3.2/§3.10).
 *
 * Everything here is built on `injectableSecretWhere`, which is the same
 * question the container-config builder asks and which fails closed (no grants
 * selects nothing, never the pool). That is the point: a second opinion about
 * what will inject is worse than no opinion, because it produces an agent the
 * dashboard calls ready and the gateway 401s.
 *
 * The credential VALUE never appears here. Callers that need it ask for it
 * explicitly, and only the models endpoint does.
 */

export interface ResolvedLlmCredential {
  provider: LlmProviderId;
  secretId: string;
  authMode: "api-key" | "oauth";
  /**
   * "workspace" | "organization" — which grant won, for explaining the
   * choice — or "platform" for the trial-credit credential (see below).
   */
  scope: string;
  /** 1Password-sourced secrets have no stored value the control plane can read. */
  hasReadableValue: boolean;
}

const authModeOf = (
  provider: LlmProviderId,
  metadata: unknown,
): "api-key" | "oauth" => {
  const parsed =
    provider === "anthropic"
      ? parseAnthropicMetadata(metadata)
      : parseOpenaiMetadata(metadata);
  // Legacy secrets predate the metadata; api-key is what the container builder
  // assumes for them too, so the two agree by construction.
  return parsed?.authMode ?? "api-key";
};

/**
 * Narrow a secret row to one this registry can serve, at the OBJECT level — so
 * the `type` field is narrowed on the row itself and no `as` cast is needed
 * downstream.
 */
const isLlmSecret = <T extends { type: string }>(
  secret: T,
): secret is T & { type: LlmProviderId } => isLlmProviderId(secret.type);

/**
 * Rank two reachable keys. SCOPE FIRST — a workspace-level grant beats an
 * org-level one, because it is the more specific and more deliberate act, and
 * because it is already how the gateway resolves two keys of the SAME type
 * (`SCOPE_PRECEDENCE` in `injectable-secrets`). Provider order only separates
 * keys that tie on scope, so the answer never depends on which provider
 * someone happened to configure first.
 *
 * The comparator must be TOTAL. Two keys of the same type at the same scope
 * are a real state, and leaving them to the order Postgres happened to return
 * is the exact defect `SCOPE_PRECEDENCE` exists to prevent — worse here,
 * because `secretId` decides which key the catalog is fetched with, so a
 * wobble could list models with a different key than the gateway injects.
 */
const rank = (secret: { scope: string; type: LlmProviderId; id: string }) =>
  [
    secret.scope === "workspace" ? 0 : 1,
    llmProvider(secret.type).order,
  ] as const;

const byPrecedence = (
  a: { scope: string; type: LlmProviderId; id: string },
  b: { scope: string; type: LlmProviderId; id: string },
): number => {
  const [aScope, aProvider] = rank(a);
  const [bScope, bProvider] = rank(b);
  // Falls through to the id so the answer is stable for genuine ties.
  return aScope - bScope || aProvider - bProvider || a.id.localeCompare(b.id);
};

/**
 * The platform trial credential, when the trial credit applies to this
 * agent's org/workspace (cloud-only; the licensed provider is injected at
 * boot — `null` everywhere else, so this resolves nothing on onprem).
 *
 * Eligibility is decided on the UNFILTERED org+workspace pool — NOT the
 * grant-narrowed `where` — mirroring the gateway exactly: an
 * existing-but-restricted LLM key counts as present, so a restriction is
 * never bypassed with free credit.
 *
 * The shape is honest about what the control plane holds: `hasReadableValue:
 * false` (the key lives only in the gateway's env; the models catalog serves
 * its pinned list), sentinel `secretId` (nothing may decrypt or grant it),
 * and `scope: "platform"` so the UI can explain the provider choice.
 */
const platformTrialCredential = async (
  workspaceId: string,
  organizationId: string,
): Promise<ResolvedLlmCredential | null> => {
  const platform = getPlatformLlm();
  if (!platform) return null;
  const pool = await db.secret.findMany({
    where: { OR: [{ workspaceId }, { organizationId, scope: "organization" }] },
    select: { type: true, hostPattern: true },
  });
  if (!platform.trialCreditApplies(pool)) return null;
  return {
    provider: "anthropic",
    secretId: PLATFORM_LLM_SECRET_ID,
    authMode: "api-key",
    scope: "platform",
    hasReadableValue: false,
  };
};

export const resolveAgentLlmCredential = async (
  agent: { id: string; workspaceId: string },
  organizationId: string,
  /** Pass a `where` you already computed — it costs three queries to build. */
  precomputedWhere?: Prisma.SecretWhereInput,
): Promise<ResolvedLlmCredential | null> => {
  const where =
    precomputedWhere ??
    (await injectableSecretWhere(agent, agent.workspaceId, organizationId));
  const candidates = await db.secret.findMany({
    where: { AND: [where, { type: { in: LLM_PROVIDER_IDS } }] },
    select: {
      id: true,
      type: true,
      scope: true,
      metadata: true,
      valueSource: true,
      encryptedValue: true,
    },
  });

  const winner = candidates.filter(isLlmSecret).sort(byPrecedence)[0];
  if (!winner)
    return platformTrialCredential(agent.workspaceId, organizationId);

  return {
    provider: winner.type,
    secretId: winner.id,
    authMode: authModeOf(winner.type, winner.metadata),
    scope: winner.scope,
    hasReadableValue:
      winner.valueSource !== "onepassword" && winner.encryptedValue !== null,
  };
};

/**
 * Load an agent with what the resolver needs, or null if it is not this
 * workspace's. One query, fenced in the `where` per the house rule.
 */
export const loadAgentForLlm = async (workspaceId: string, agentId: string) =>
  db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: {
      id: true,
      kind: true,
      workspaceId: true,
      model: true,
      effort: true,
      modelProvider: true,
      workspace: { select: { organizationId: true } },
    },
  });

/**
 * Why this agent cannot run a turn right now, or null if it can — DOOR 1 of
 * the §3.2 check (`turn-service.createTurn`).
 *
 * Its verb is "answer the thread": the caller writes this onto the turn it
 * just created, so the user sees the reason where they are already looking,
 * rather than a 400 the composer has to invent copy for. Door 2 lives in the
 * container-config builder and refuses to compose a payload — see the comment
 * there for why both exist.
 */
export const findAgentLlmBlocker = async (
  workspaceId: string,
  agentId: string,
): Promise<{ code: TurnErrorCode; message: string } | null> => {
  const agent = await loadAgentForLlm(workspaceId, agentId);
  // Not ours, or not a kind that runs anything — either way this check has no
  // opinion; the callers' own fences own those cases.
  if (!agent || agent.kind !== "hosted") return null;

  const credential = await resolveAgentLlmCredential(
    { id: agent.id, workspaceId: agent.workspaceId },
    agent.workspace.organizationId,
  );
  return credential
    ? null
    : { code: "no_model_key", message: NO_MODEL_KEY_MESSAGE };
};

/**
 * The plaintext of a secret this agent may use — for the ONE caller that needs
 * it, listing a provider's models.
 *
 * Takes the fenced `where` again rather than a bare id: an id alone would let
 * a caller read any secret in the database, and this is the only function in
 * the service that returns a credential.
 */
export const readLlmCredentialValue = async (
  agent: { id: string; workspaceId: string },
  organizationId: string,
  secretId: string,
  precomputedWhere?: Prisma.SecretWhereInput,
): Promise<string | null> => {
  const where =
    precomputedWhere ??
    (await injectableSecretWhere(agent, agent.workspaceId, organizationId));
  const secret = await db.secret.findFirst({
    where: { AND: [where, { id: secretId }] },
    select: { encryptedValue: true, valueSource: true },
  });
  if (!secret?.encryptedValue || secret.valueSource === "onepassword")
    return null;
  try {
    return await getCrypto().decrypt(secret.encryptedValue);
  } catch {
    // A key we cannot decrypt is one we cannot list with. The container
    // builder already warns about this case; here it simply degrades.
    return null;
  }
};
