import { z } from "zod";
import {
  CHANNEL_PROVIDER_IDS,
  CHANNEL_TRANSPORTS,
} from "../services/channels/types";

/**
 * Zod surfaces for the channel routes (step 6). One definition per union —
 * the services import from `services/channels/types`; these schemas are the
 * HTTP shells around them.
 */

export const channelProviderSchema = z.enum(CHANNEL_PROVIDER_IDS);

/** The connection-mode vocabulary — the manifest GET validates its
 * `?transport=` with this directly (query params are bare strings). */
export const channelTransportSchema = z.enum(CHANNEL_TRANSPORTS);

/** POST /v1/agents/:agentId/channels/:provider: the caller's connection-mode
 * choice — optional, the deployment posture decides when omitted. */
export const attachPresenceSchema = z
  .object({
    transport: channelTransportSchema.optional(),
  })
  .strict();

/** PUT /v1/org/channels/:provider/credentials */
export const connectIntegrationSchema = z
  .object({
    credential: z.string().trim().min(1).max(4_000),
  })
  .strict();

/** POST /v1/org/channels/:provider/finish-install/inspect — the Slack
 * authorization code parked by a marketplace install. Opaque to us; bounded
 * because it rides a URL. */
export const inspectInstallSchema = z
  .object({
    code: z.string().trim().min(1).max(2_000),
  })
  .strict();

/** POST /v1/org/channels/:provider/finish-install — the sealed claim the
 * inspect step returned (HMAC-signed, carries the encrypted exchanged
 * grant, so it is larger than the code it replaced). */
export const finishInstallSchema = z
  .object({
    claim: z.string().trim().min(1).max(16_000),
  })
  .strict();

/** POST /v1/org/channels/:provider/user-links */
export const addUserLinkSchema = z
  .object({
    externalUserId: z.string().trim().min(1).max(200),
    userId: z.string().trim().min(1).max(200),
  })
  .strict();

/** POST /v1/agents/:agentId/channels/:provider/complete */
export const completePresenceSchema = z
  .object({
    botToken: z.string().trim().min(1).max(500),
    appToken: z.string().trim().min(1).max(500).optional(),
    signingSecret: z.string().trim().min(1).max(500).optional(),
    appId: z.string().trim().min(1).max(100).optional(),
    transport: channelTransportSchema.optional(),
  })
  .strict();

/** DELETE /v1/agents/:agentId/channels/:provider */
export const detachPresenceSchema = z
  .object({
    deleteRemote: z.boolean().optional(),
  })
  .strict();

/** POST /channel-adapter/reach-decision - a forwarded reach-card click
 * (socket arm). Mirrors adapterDecisionSchema; the wire schema is the
 * shared truth (agent-protocol). */
export const adapterReachDecisionSchema = z
  .object({
    presenceId: z.string().trim().min(1).max(200),
    grantId: z.string().trim().min(1).max(500),
    // Both vocabularies: the three-way settlement, plus the pre-rename
    // pair an older channel-adapter deployable still sends mid-rollout
    // ("deny" always meant "OneCLI users only" = members_only).
    decision: z
      .enum(["approved", "members_only", "blocked", "approve", "deny"])
      .transform((d) =>
        d === "approve" ? "approved" : d === "deny" ? "members_only" : d,
      ),
    clickerExternalUserId: z.string().trim().min(1).max(200),
  })
  .strict();

/** PUT /v1/agents/:agentId/channels/:provider/reach/:externalRef - the
 * dashboard's per-space settlement. The same three answers the card asks
 * for: open to everyone in the space, OneCLI users only, or silent there.
 * `revoked` is the pre-rename spelling of `members_only`, still accepted so
 * an older dashboard bundle keeps working through a deploy. */
export const setReachStateSchema = z
  .object({
    state: z
      .enum(["approved", "members_only", "blocked", "revoked"])
      .transform((v) => (v === "revoked" ? "members_only" : v)),
  })
  .strict();

/** PUT /v1/agents/:agentId/channels/:provider/reach/people/:externalRef -
 * the dashboard's per-person settlement. Two answers only: a single human
 * either may reach the agent or may not; "OneCLI users only" describes a
 * population, not a person, so it is not offered here. */
export const setPersonReachStateSchema = z
  .object({
    state: z.enum(["approved", "blocked"]),
  })
  .strict();

// ── The adapter's wire (routes/channel-adapter.ts) ──────────────────────────
// Registration validates with `adapterRegisterRequestSchema` from
// @onecli/agent-protocol (the shared wire), not a local copy.

export const adapterIngestSchema = z
  .object({
    presenceId: z.string().trim().min(1),
    eventId: z.string().trim().min(1).max(500),
    event: z.unknown(),
    // No `email` on purpose — the control plane resolves the speaker itself
    // (a caller-asserted email is an impersonation vector; see channel-wire).
  })
  .strict();

export const adapterDecisionSchema = z
  .object({
    presenceId: z.string().trim().min(1),
    approvalId: z.string().trim().min(1).max(500),
    decision: z.enum(["approve", "deny"]),
    clickerExternalUserId: z.string().trim().min(1).max(200),
  })
  .strict();

export const adapterPromptClaimSchema = z
  .object({
    approvalId: z.string().trim().min(1).max(500),
    presenceId: z.string().trim().min(1),
    externalThreadId: z.string().trim().min(1).max(500),
    /** ISO; the gateway's real deadline, re-armed on restart. */
    expiresAt: z.string().datetime().nullable(),
  })
  .strict();

export const adapterPromptMessageSchema = z
  .object({
    approvalId: z.string().trim().min(1).max(500),
    externalMessageRef: z.string().trim().min(1).max(500),
  })
  .strict();

export const adapterPromptSettleSchema = z
  .object({
    approvalId: z.string().trim().min(1).max(500),
    state: z.enum(["decided", "expired"]),
  })
  .strict();

export const adapterCursorSchema = z
  .object({
    linkId: z.string().trim().min(1),
    /** ISO timestamps; `expect: null` claims a virgin cursor. */
    expect: z.string().datetime().nullable(),
    next: z.string().datetime(),
    /** The claimed turn — lets a WINNING claim clear the turn's reaction
     * receipt (the answer is posting, so the "seen" mark comes off). */
    turnId: z.string().trim().min(1).optional(),
  })
  .strict();

export const adapterApprovalHealthSchema = z
  .object({
    presenceId: z.string().trim().min(1),
    healthy: z.boolean(),
  })
  .strict();
