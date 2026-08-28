import { randomBytes } from "node:crypto";
import { db, Prisma } from "@onecli/db";
import { getCrypto, getRoleResolver, ROLE_HIERARCHY } from "../../providers";
import { CAPS } from "../../lib/env";
import { signOAuthState, verifyOAuthState } from "../../lib/oauth-state";
import { ServiceError } from "../errors";
import {
  buildSharedAppManifest,
  sharedAppInstallUrl,
  sharedSlackApp,
  slackAppManagerApproved,
  type SlackSharedAppConfig,
} from "./providers/slack/shared-app";
import {
  appsUninstall,
  oauthAccess,
  SlackApiError,
} from "./providers/slack/slack-api";
import { publicApiUrl } from "./posture";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "../audit-service";
import { logger } from "../../lib/logger";

const log = logger.child({ component: "shared-install-service" });

/**
 * The SHARED-app install lifecycle: one deployment-owned Slack app, installed
 * per workspace with a plain OAuth consent click. The install powers team
 * onboarding (the bot answers DMs with an account button) and — when the
 * consent granted the app-manager user scopes — minting per-agent apps
 * without a pasted config token. Per-agent dedicated apps stay the one
 * attach behavior (agent-channel-service).
 *
 * Slack-only for now, like the provider registry itself: the shapes are
 * provider-neutral (ChannelInstallation), the OAuth mechanics live in
 * `providers/slack/`.
 *
 * TRUST: the install callback carries no session. The signed state names the
 * org and the admin who started the install; the code exchange itself can
 * only be completed by the deployment's client secret. A workspace that
 * gates installs behind admin approval simply completes later — the state
 * TTL is generous (the link can sit in an approval queue), and a fresh
 * install link is one click away.
 */

/** Install links may sit in a Slack admin-approval queue — hours, not
 * minutes. 7 days matches Slack's own approval-flow patience. */
const INSTALL_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const PROVIDER = "slack" as const;

export interface SharedAppView {
  /** ADVERTISE the shared app (the "Add to Slack" door): the deployment has
   * it configured and is reachable over public HTTPS. */
  available: boolean;
  /** The install carries a user token that can mint agent apps — the org
   * needs no pasted config token. */
  canMintAgentApps: boolean;
  /** A NEW install would capture the agent-app minting scopes (Slack has
   * enrolled the deployment's app as a manager app). Until then the shared
   * app is onboarding-only, so the setup choice leads with the config-token
   * paste instead. */
  installMintsAgentApps: boolean;
  /** This org's workspace install, when one exists — returned regardless of
   * `available`, so an install made from Slack's side stays visible (and
   * removable) even while the deployment isn't advertising the feature. */
  installation: {
    tenant: { externalId: string; name: string | null };
    botUserId: string | null;
    createdAt: Date;
  } | null;
}

/** The shared install's decrypted credential shape (Slack: the bot token
 * plus, when the consent granted user scopes, the admin's user token). */
export interface SharedInstallCredentials {
  botToken?: string;
  userToken?: string;
  userTokenScopes?: string;
  /** WHOSE user token this is (`authed_user.id` at exchange time): the
   * `tokens_revoked` handler strips the token only when THIS user's grant
   * was revoked — any other member's revocation must not kill the live
   * mint capability. */
  installerSlackUserId?: string;
  /** Set after Slack refused the user token for manifest calls
   * (invalid_manager_app — the app lacks marketplace approval). */
  managerAppRefused?: boolean;
}

/** Can these credentials mint agent apps? ONE rule, shared by the view
 * (sharedInstallCanMintApps) and the mint path
 * (withFreshIntegrationCredentials) so the two can never drift. */
export const credentialsCanMintApps = (
  creds: SharedInstallCredentials,
): boolean =>
  Boolean(
    !creds.managerAppRefused &&
    creds.userToken &&
    (creds.userTokenScopes ?? "").includes("app_configurations:write"),
  );

/** What the inbound arm needs per event: the install's id (routing +
 * dedupe key), its bot's own user id (the echo guard), and the bot token
 * (the reply). */
export interface SharedInstallationRow {
  id: string;
  botUserId: string | null;
  botToken: string | null;
}

/**
 * The inbound arm's per-team lookup, briefly cached: the KMS decrypt behind
 * `getCrypto()` must not run once per webhook event. Negative results are
 * cached too (events from unknown workspaces must stay cheap to drop) —
 * which is exactly why the cache lives HERE: every credential-changing
 * write in this service (install, reinstall, user-token strip, disconnect)
 * invalidates the entry. Two bounds keep that honest:
 * - the cache is PER PROCESS, so a write on one api-server task cannot
 *   invalidate a sibling task's entry — negatives get a much shorter TTL
 *   than positives so a just-installed workspace's first DM is dropped for
 *   at most seconds on tasks that cached "not installed" mid-install (and a
 *   just-disconnected bot answers for at most the positive TTL elsewhere);
 * - within a process, an invalidation EPOCH closes the read race: a lookup
 *   that read the DB before a write landed must not re-cache its stale
 *   answer after the write's invalidation ran.
 */
const SHARED_INSTALL_CACHE_TTL_MS = 60_000;
const SHARED_INSTALL_NEGATIVE_TTL_MS = 5_000;
const sharedInstallationCache = new Map<
  string,
  { row: SharedInstallationRow | null; at: number }
>();
let sharedInstallationCacheEpoch = 0;

export const invalidateSharedInstallationCache = (teamId: string): void => {
  sharedInstallationCacheEpoch += 1;
  sharedInstallationCache.delete(teamId);
};

/** The workspace install behind a shared-app event, by Slack team id. */
export const sharedInstallationByTeam = async (
  teamId: string | undefined,
): Promise<SharedInstallationRow | null> => {
  if (!teamId) return null;
  const cached = sharedInstallationCache.get(teamId);
  if (
    cached &&
    Date.now() - cached.at <
      (cached.row
        ? SHARED_INSTALL_CACHE_TTL_MS
        : SHARED_INSTALL_NEGATIVE_TTL_MS)
  ) {
    return cached.row;
  }
  const epochAtRead = sharedInstallationCacheEpoch;
  const row = await db.channelInstallation.findUnique({
    where: { provider_externalId: { provider: PROVIDER, externalId: teamId } },
    select: { id: true, botUserId: true, credentials: true },
  });
  let resolved: SharedInstallationRow | null = null;
  if (row) {
    try {
      const creds = JSON.parse(await getCrypto().decrypt(row.credentials)) as {
        botToken?: string;
      };
      resolved = {
        id: row.id,
        botUserId: row.botUserId,
        botToken: creds.botToken ?? null,
      };
    } catch {
      resolved = { id: row.id, botUserId: row.botUserId, botToken: null };
    }
  }
  // A write invalidated mid-read: our answer may predate it — serve it once
  // but don't re-cache it over the fresher truth.
  if (sharedInstallationCacheEpoch === epochAtRead) {
    sharedInstallationCache.set(teamId, { row: resolved, at: Date.now() });
  }
  return resolved;
};

/**
 * Does the org's shared workspace install hold a user token with the
 * manifest scope? THE question both the UI (hide the config-token card)
 * and the mint path (skip the config token) ask. One decrypt per call —
 * view-frequency, not event-frequency.
 */
export const sharedInstallCanMintApps = async (
  organizationId: string,
): Promise<boolean> => {
  if (!sharedSlackApp()) return false;
  const row = await db.channelInstallation.findFirst({
    where: { provider: PROVIDER, integration: { organizationId } },
    select: { credentials: true },
  });
  if (!row) return false;
  try {
    const creds = JSON.parse(
      await getCrypto().decrypt(row.credentials),
    ) as SharedInstallCredentials;
    return credentialsCanMintApps(creds);
  } catch {
    return false;
  }
};

export const getSharedAppView = async (
  organizationId: string,
): Promise<SharedAppView> => {
  const app = sharedSlackApp();

  const row = await db.channelInstallation.findFirst({
    where: {
      provider: PROVIDER,
      integration: { organizationId },
    },
    select: {
      botUserId: true,
      createdAt: true,
      credentials: true,
      integration: { select: { externalId: true, name: true } },
    },
  });

  // One decrypt for the whole view (same rule as sharedInstallCanMintApps —
  // credentialsCanMintApps is THE shared predicate; only the row fetch is
  // collapsed here).
  let canMintAgentApps = false;
  if (app && row) {
    try {
      const creds = JSON.parse(
        await getCrypto().decrypt(row.credentials),
      ) as SharedInstallCredentials;
      canMintAgentApps = credentialsCanMintApps(creds);
    } catch {
      canMintAgentApps = false;
    }
  }

  return {
    available: app !== null && publicApiUrl() !== null,
    canMintAgentApps,
    installMintsAgentApps: slackAppManagerApproved(),
    installation: row
      ? {
          tenant: {
            externalId: row.integration.externalId,
            name: row.integration.name,
          },
          botUserId: row.botUserId,
          createdAt: row.createdAt,
        }
      : null,
  };
};

/**
 * Mint the "Add to Slack" consent URL. Admin-gated at the route; the signed
 * state pins the org and the actor so the sessionless callback can trust
 * both. Idempotent and side-effect free — an abandoned link costs nothing,
 * and a workspace whose admins gate installs can hold it for days.
 */
export const startSharedInstall = (input: {
  organizationId: string;
  actorUserId: string;
}): { installUrl: string } => {
  const app = sharedSlackApp();
  if (!app) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "This deployment has no shared Slack app configured.",
    );
  }
  const apiUrl = publicApiUrl();
  if (!apiUrl) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "The shared Slack app needs a public HTTPS API origin.",
    );
  }
  const state = signOAuthState({
    provider: PROVIDER,
    nonce: randomBytes(16).toString("hex"),
    kind: "shared-install",
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    issuedAt: Date.now(),
  });
  return {
    installUrl: sharedAppInstallUrl({
      clientId: app.clientId,
      redirectUri: `${apiUrl}/v1/channels/slack/oauth/callback`,
      state,
    }),
  };
};

/**
 * The DIRECT-INSTALL door: Slack's Marketplace listing points its install
 * button at a URL we host, which must 302 to a fully-qualified authorize URL
 * (Slack validates that contract when the listing is configured). No session
 * exists at that moment, so the state is an ANONYMOUS signed nonce — it binds
 * no org (the `/slack/installed` finish binds one from a session); it exists
 * so every authorize URL we mint carries a verifiable state (the Marketplace
 * guideline) and the callback can tell our mint from a bare stateless
 * install. Null when the deployment has no shared app or no public origin.
 */
export const startMarketplaceInstall = (): { installUrl: string } | null => {
  const app = sharedSlackApp();
  const apiUrl = publicApiUrl();
  if (!app || !apiUrl) return null;
  const state = signOAuthState({
    provider: PROVIDER,
    nonce: randomBytes(16).toString("hex"),
    kind: "marketplace-install",
    issuedAt: Date.now(),
  });
  return {
    installUrl: sharedAppInstallUrl({
      clientId: app.clientId,
      redirectUri: `${apiUrl}/v1/channels/slack/oauth/callback`,
      state,
    }),
  };
};

/** A marketplace-install state is ours, the right kind, and current. It
 * grants nothing by itself — the callback only parks the code at the app. */
export const verifyMarketplaceInstallState = (state: string): boolean => {
  const payload = verifyOAuthState(state);
  return Boolean(
    payload &&
    payload.kind === "marketplace-install" &&
    typeof payload.issuedAt === "number" &&
    Date.now() - payload.issuedAt <= INSTALL_STATE_TTL_MS,
  );
};

/**
 * Workspace-side partial revocation (`tokens_revoked` with only USER tokens):
 * the installing admin's user token died — deactivated admin, trimmed grant —
 * but the bot install lives on. Drop the dead token so the mint capability
 * reads false instead of failing at call time; the bot token stays.
 *
 * `revokedUserIds` is Slack's `tokens.oauth` list (whose xoxp tokens died).
 * The strip is TARGETED: only the stored installer's revocation counts — a
 * different member who once authorized the app getting deactivated must not
 * kill the live mint grant. Installs recorded before the installer id was
 * persisted strip on any revocation (the safe side: a dead token reads as
 * "no capability" instead of failing at call time).
 */
export const stripSharedInstallUserToken = async (
  teamId: string,
  revokedUserIds?: string[],
): Promise<void> => {
  const row = await db.channelInstallation.findUnique({
    where: { provider_externalId: { provider: PROVIDER, externalId: teamId } },
    select: { id: true, credentials: true },
  });
  if (!row) return;
  try {
    const creds = JSON.parse(
      await getCrypto().decrypt(row.credentials),
    ) as SharedInstallCredentials;
    if (!creds.userToken && !creds.userTokenScopes) return;
    if (
      revokedUserIds &&
      creds.installerSlackUserId &&
      !revokedUserIds.includes(creds.installerSlackUserId)
    ) {
      return;
    }
    // Compare-and-swap on the exact ciphertext read: this races a reinstall
    // (fresh credentials committed while the event was in flight), and the
    // stale strip must lose — count 0 means someone rewrote the row and the
    // revocation applied to tokens that are no longer stored.
    const { count } = await db.channelInstallation.updateMany({
      where: { id: row.id, credentials: row.credentials },
      data: {
        credentials: await getCrypto().encrypt(
          JSON.stringify({ botToken: creds.botToken }),
        ),
      },
    });
    if (count > 0) invalidateSharedInstallationCache(teamId);
  } catch (err) {
    // Unreadable credentials already read as "no capability" everywhere.
    log.warn({ err, teamId }, "could not strip a revoked shared user token");
  }
};

/**
 * The callback's shared-install arm: verify the state, exchange the code
 * with the DEPLOYMENT's client credentials, and record the workspace install
 * (the laws live on `recordSharedInstall`).
 */
export const completeSharedInstallFromOAuth = async (input: {
  state: string;
  code: string;
  redirectUri: string;
}): Promise<{ organizationId: string; teamId: string }> => {
  const app = sharedSlackApp();
  if (!app) {
    throw new ServiceError("UNPROCESSABLE", "This install link is not valid");
  }
  const payload = verifyOAuthState(input.state);
  if (
    !payload ||
    payload.kind !== "shared-install" ||
    typeof payload.organizationId !== "string" ||
    typeof payload.actorUserId !== "string" ||
    typeof payload.issuedAt !== "number" ||
    Date.now() - payload.issuedAt > INSTALL_STATE_TTL_MS
  ) {
    throw new ServiceError("UNPROCESSABLE", "This install link is not valid");
  }
  const organizationId = payload.organizationId;
  const actorUserId = payload.actorUserId;

  // The actor must still be a live member of the org — the state is a
  // capability, and a departed admin's link must die with their membership.
  const membership = await db.organizationMember.findFirst({
    where: {
      organizationId,
      userId: actorUserId,
      NOT: { status: "suspended" },
    },
    select: { userId: true },
  });
  if (!membership) {
    throw new ServiceError("UNPROCESSABLE", "This install link is not valid");
  }

  // Where roles are enforced, re-run the SAME gate the mint route used: the
  // state can sit in an approval queue for days, and a demoted admin's
  // parked link must not outrank their live permissions. (Membership above
  // stays the RBAC-off floor.)
  if (CAPS.rbac) {
    const resolver = getRoleResolver();
    const role = resolver
      ? await resolver.getUserRole(actorUserId, organizationId)
      : null;
    if (!role || ROLE_HIERARCHY[role] < ROLE_HIERARCHY.admin) {
      throw new ServiceError("UNPROCESSABLE", "This install link is not valid");
    }
  }

  const result = await recordSharedInstall({
    organizationId,
    actorUserId,
    code: input.code,
    redirectUri: input.redirectUri,
  });

  // The session-bearing routes audit themselves; this sessionless arm is the
  // path every dashboard-initiated install actually completes through, and a
  // credential write with no audit trail fails the CLAUDE.md law. The actor
  // is the state's — verified live above. recordAuditEvent never throws.
  const actor = await db.user.findUnique({
    where: { id: actorUserId },
    select: { email: true },
  });
  await recordAuditEvent({
    organizationId,
    userId: actorUserId,
    userEmail: actor?.email ?? "",
    action: AUDIT_ACTIONS.CREATE,
    service: AUDIT_SERVICES.CHANNEL,
    source: AUDIT_SOURCE.API,
    metadata: {
      provider: PROVIDER,
      sharedInstall: "installed",
      teamId: result.teamId,
    },
  });

  return result;
};

/**
 * The MARKETPLACE arm, step 1 of 2: an install that began OUTSIDE OneCLI —
 * the "Add to Slack" button in Slack's app directory, or the app's sharable
 * URL. No state exists to sign, because no OneCLI session existed when the
 * install started; the callback parks the code, the person signs in, and the
 * org comes from that SESSION instead of from the state.
 *
 * TRUST: the human confirmation is the security control on this arm, and a
 * confirmation is only informed if it can NAME the workspace being bound —
 * which lives inside the unexchanged code. So the finish is two-step:
 * INSPECT exchanges the code immediately (also outrunning its 10-minute
 * expiry) and returns the team identity plus a sealed CLAIM — the exchanged
 * grant encrypted with the at-rest crypto and HMAC-bound to this org and
 * actor — without persisting anything. The page shows "connect workspace X
 * to org Y?", and only the CONFIRM below binds. An abandoned claim persists
 * nothing; the installed app stays in the workspace until its own admin
 * removes it, like any abandoned OAuth consent.
 */
const FINISH_CLAIM_TTL_MS = 10 * 60 * 1000;

type SharedInstallExchange = Awaited<ReturnType<typeof oauthAccess>>;

export const inspectSharedInstallCode = async (input: {
  organizationId: string;
  actorUserId: string;
  code: string;
  redirectUri: string;
}): Promise<{
  team: { externalId: string; name: string | null };
  claim: string;
}> => {
  const app = sharedSlackApp();
  if (!app) {
    throw new ServiceError("UNPROCESSABLE", "This install link is not valid");
  }
  const exchanged = await exchangeSharedInstallCode(app, input);
  const sealed = await getCrypto().encrypt(JSON.stringify(exchanged));
  const claim = signOAuthState({
    provider: PROVIDER,
    nonce: randomBytes(16).toString("hex"),
    kind: "finish-install-claim",
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    teamId: exchanged.team.id,
    sealed,
    issuedAt: Date.now(),
  });
  return {
    team: {
      externalId: exchanged.team.id,
      name: exchanged.team.name ?? null,
    },
    claim,
  };
};

/**
 * The MARKETPLACE arm, step 2 of 2: spend an inspected claim. The claim is
 * HMAC-signed and carries the org and actor it was minted for — the SAME
 * authenticated caller must confirm it (a leaked claim URL is inert in
 * anyone else's session, unlike the code it replaced). All the conflict
 * laws re-run inside the persist.
 */
export const confirmSharedInstallFromClaim = async (input: {
  organizationId: string;
  actorUserId: string;
  claim: string;
}): Promise<{ organizationId: string; teamId: string }> => {
  const app = sharedSlackApp();
  if (!app) {
    throw new ServiceError("UNPROCESSABLE", "This install link is not valid");
  }
  const payload = verifyOAuthState(input.claim);
  if (
    !payload ||
    payload.kind !== "finish-install-claim" ||
    typeof payload.sealed !== "string" ||
    typeof payload.issuedAt !== "number" ||
    Date.now() - payload.issuedAt > FINISH_CLAIM_TTL_MS ||
    payload.organizationId !== input.organizationId ||
    payload.actorUserId !== input.actorUserId
  ) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "This install confirmation has expired — start the install again from Slack.",
    );
  }
  let exchanged: SharedInstallExchange;
  try {
    exchanged = JSON.parse(
      await getCrypto().decrypt(payload.sealed),
    ) as SharedInstallExchange;
  } catch {
    throw new ServiceError(
      "UNPROCESSABLE",
      "This install confirmation has expired — start the install again from Slack.",
    );
  }
  return persistSharedInstall(app, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    exchanged,
  });
};

/**
 * Exchange the code and record the workspace install — the half BOTH arms
 * share. The only thing that differs upstream is how the org was
 * established: a signed state, or the caller's session.
 *
 * Laws:
 * - one org per Slack workspace (the installation `(provider, externalId)`
 *   unique) — the second org's install is a CONFLICT, not a rebind;
 * - one workspace per org integration (the integration `externalId` check —
 *   same law the dedicated arm's `activatePresence` holds);
 * - a REINSTALL (same org, same workspace) refreshes the token and bot id
 *   in place.
 */
const exchangeSharedInstallCode = async (
  app: SlackSharedAppConfig,
  input: { code: string; redirectUri: string },
): Promise<SharedInstallExchange> => {
  try {
    return await oauthAccess({
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      code: input.code,
      redirectUri: input.redirectUri,
    });
  } catch (err) {
    // Slack codes expire after ten minutes and are single-use. The
    // marketplace arm parks the code across a human sign-IN — or sign-UP,
    // which can easily outlive it. Name the recovery instead of echoing
    // Slack's bare `invalid_code`.
    if (err instanceof SlackApiError && err.code === "invalid_code") {
      throw new ServiceError(
        "UNPROCESSABLE",
        "This Slack install link has expired (Slack codes last ten minutes). " +
          "Start the install again from Slack and finish right away.",
      );
    }
    throw err;
  }
};

const recordSharedInstall = async (input: {
  organizationId: string;
  actorUserId: string;
  code: string;
  redirectUri: string;
}): Promise<{ organizationId: string; teamId: string }> => {
  const app = sharedSlackApp();
  if (!app) {
    throw new ServiceError("UNPROCESSABLE", "This install link is not valid");
  }
  const exchanged = await exchangeSharedInstallCode(app, input);
  return persistSharedInstall(app, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    exchanged,
  });
};

const persistSharedInstall = async (
  app: SlackSharedAppConfig,
  input: {
    organizationId: string;
    actorUserId: string;
    exchanged: SharedInstallExchange;
  },
): Promise<{ organizationId: string; teamId: string }> => {
  const { organizationId, actorUserId, exchanged } = input;
  const teamId = exchanged.team.id;
  const teamName = exchanged.team.name ?? null;

  // Encrypted OUTSIDE the transaction — the KMS round-trip must not hold a
  // database transaction open.
  const credentials = await getCrypto().encrypt(
    JSON.stringify({
      botToken: exchanged.access_token,
      // The installing admin's user token: the manifest+managed-install
      // grant that lets the deployment mint per-agent apps without a
      // pasted config token. Absent when the workspace trimmed user
      // scopes at consent time; the config-token fallback covers that.
      ...(exchanged.authed_user?.access_token && {
        userToken: exchanged.authed_user.access_token,
        userTokenScopes: exchanged.authed_user.scope ?? "",
        // Whose grant this is — `tokens_revoked` strips only when THIS
        // user's token was revoked.
        installerSlackUserId: exchanged.authed_user.id,
      }),
    }),
  );

  // ONE transaction for the checks and writes: a refused install must leave
  // nothing behind. Without it, a lost race on the installation unique would
  // strand a fresh integration row pinned to the contested team id — and
  // that phantom poisons the org's every later install attempt with the
  // "different workspace" refusal.
  try {
    await db.$transaction(async (tx) => {
      // One org per Slack workspace — refusing is the whole point of the
      // unique (inbound routing resolves by team id). The DB unique + the
      // P2002 catch below remain the race backstop.
      const claimed = await tx.channelInstallation.findUnique({
        where: {
          provider_externalId: { provider: PROVIDER, externalId: teamId },
        },
        select: {
          id: true,
          integration: { select: { organizationId: true } },
        },
      });
      if (claimed && claimed.integration.organizationId !== organizationId) {
        throw new ServiceError(
          "CONFLICT",
          "This Slack workspace is already connected to another organization.",
        );
      }

      // The org's integration row binds it to ONE provider tenant. Same
      // conflict law as the dedicated arm: an integration pointing at
      // another workspace refuses rather than quietly rebinding.
      const integration = await tx.channelIntegration.findUnique({
        where: {
          organizationId_provider: { organizationId, provider: PROVIDER },
        },
        select: { id: true, externalId: true, name: true },
      });
      if (integration && integration.externalId !== teamId) {
        throw new ServiceError(
          "CONFLICT",
          "Your organization's Slack connection points at a different workspace.",
        );
      }
      const integrationId = integration
        ? integration.id
        : (
            await tx.channelIntegration.create({
              data: {
                organizationId,
                provider: PROVIDER,
                externalId: teamId,
                name: teamName,
                createdByUserId: actorUserId,
              },
              select: { id: true },
            })
          ).id;
      if (integration && !integration.name && teamName) {
        await tx.channelIntegration.update({
          where: { id: integration.id },
          data: { name: teamName },
        });
      }

      if (claimed) {
        // Ours (the org check above passed): a REINSTALL refreshes in place.
        await tx.channelInstallation.update({
          where: { id: claimed.id },
          data: {
            appId: exchanged.app_id ?? app.appId,
            botUserId: exchanged.bot_user_id,
            credentials,
            // Re-attribute: the onboarding bot vouches invitations in the
            // installer's name, so a reinstall by a live admin must repair
            // an install whose original creator left (SetNull) or was
            // suspended.
            createdByUserId: actorUserId,
          },
          select: { id: true },
        });
      } else {
        await tx.channelInstallation.create({
          data: {
            integrationId,
            provider: PROVIDER,
            externalId: teamId,
            appId: exchanged.app_id ?? app.appId,
            botUserId: exchanged.bot_user_id,
            credentials,
            createdByUserId: actorUserId,
          },
          select: { id: true },
        });
      }
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      // TWO uniques can lose a race here, and they mean different things:
      // the installation's (provider, external_id) is a FOREIGN org holding
      // the workspace; the integration's (organization_id, provider) is our
      // OWN org's concurrent install (two admins clicking at once) — telling
      // that admin a foreign org squatted their workspace is false and
      // alarming.
      const target = Array.isArray(err.meta?.target)
        ? err.meta.target.join(",")
        : String(err.meta?.target ?? "");
      if (target.includes("external_id")) {
        throw new ServiceError(
          "CONFLICT",
          "This Slack workspace is already connected to another organization.",
        );
      }
      throw new ServiceError(
        "CONFLICT",
        "A Slack install for your organization just completed — refresh to see it.",
      );
    }
    throw err;
  }

  // A cached NEGATIVE for this team (the workspace probed the bot while the
  // code was parked) must not eat the first post-install DM.
  invalidateSharedInstallationCache(teamId);

  log.info({ organizationId, teamId }, "shared Slack app installed");
  return { organizationId, teamId };
};

/**
 * Disconnect the org's shared-app install. Slack-side: `apps.uninstall`
 * needs the app's client credentials — the deployment has them, so the
 * uninstall is attempted best-effort; a dead token must never block the
 * disconnect. Returns false when nothing was installed.
 */
export const disconnectSharedInstall = async (
  organizationId: string,
): Promise<boolean> => {
  const row = await db.channelInstallation.findFirst({
    where: { provider: PROVIDER, integration: { organizationId } },
    select: {
      id: true,
      externalId: true,
      credentials: true,
    },
  });
  if (!row) return false;

  const app = sharedSlackApp();
  if (app) {
    try {
      const json = JSON.parse(await getCrypto().decrypt(row.credentials)) as {
        botToken?: string;
      };
      if (json.botToken) {
        await appsUninstall({
          botToken: json.botToken,
          clientId: app.clientId,
          clientSecret: app.clientSecret,
        });
      }
    } catch (err) {
      log.warn(
        { err, organizationId },
        "shared app uninstall failed; disconnecting locally anyway",
      );
    }
  }

  await db.channelInstallation.delete({ where: { id: row.id } });
  // The disconnected bot must stop answering NOW, not at the cache TTL.
  invalidateSharedInstallationCache(row.externalId);
  return true;
};

/**
 * The manifest a self-hosted operator creates THEIR shared app from — served
 * by the org channels surface. Null when the deployment has no public HTTPS
 * origin (the shared app is events-only by design).
 */
export const sharedAppSetupManifest = (): Record<string, unknown> | null => {
  const apiUrl = publicApiUrl();
  return apiUrl ? buildSharedAppManifest({ publicApiUrl: apiUrl }) : null;
};
