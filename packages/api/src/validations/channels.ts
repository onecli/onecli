import { z } from "zod";
import {
  actionChoiceSchema,
  adapterCardFollowUpActionRequestSchema,
  adapterCardStopRequestSchema,
  adapterGroupDecisionRequestSchema,
} from "@onecli/agent-protocol";
import {
  CHANNEL_PROVIDER_IDS,
  CHANNEL_TRANSPORTS,
  LISTEN_MODES,
} from "../services/channels/types";
import { MAX_OUTCOME_IDS } from "./approval-outcomes";

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

/** POST /v1/org/channels/:provider/agent-install and
 * POST /v1/org/channels/:provider/finish-install/inspect: the provider's
 * authorization code from an install begun on the provider's side, parked
 * on /slack/installed. Opaque to us; bounded because it rides a URL. */
export const installCodeSchema = z
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

/** POST /v1/agents/:agentId/channels/:provider/complete. `botToken` may be
 * omitted only on a socket presence a consent install already gave one; the
 * provider enforces that. */
export const completePresenceSchema = z
  .object({
    botToken: z.string().trim().min(1).max(500).optional(),
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
    // Two answers, plus retired values an older channel-adapter deployable
    // may still send mid-rollout: `approve` (old spelling), and
    // `members_only` / `deny` (the retired "OneCLI users only"), which
    // settle as `approved` - the same mapping the data migration applied.
    decision: z
      .enum(["approved", "blocked", "approve", "members_only", "deny"])
      .transform((d) => (d === "blocked" ? "blocked" : "approved")),
    clickerExternalUserId: z.string().trim().min(1).max(200),
  })
  .strict();

/** PUT /v1/agents/:agentId/channels/:provider/reach/:externalRef - the
 * dashboard's per-space settlement: the same two answers the card asks for
 * (everyone here, or silent here). Retired values an older dashboard bundle
 * may send mid-deploy (`members_only`, `revoked`) settle as `approved`. */
export const setReachStateSchema = z
  .object({
    state: z
      .enum(["approved", "blocked", "members_only", "revoked"])
      .transform((v) => (v === "blocked" ? "blocked" : "approved")),
  })
  .strict();

/** Promote/demote the agent in a channel: what it hears there. */
export const setSpaceListenSchema = z
  .object({ listen: z.enum(LISTEN_MODES) })
  .strict();

/** PUT /v1/agents/:agentId/channels/:provider/reach/people/:externalRef -
 * the dashboard's per-person setting: Always allow, or Never. */
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

/** POST /channel-adapter/group-decision - a grouped approval card's click
 * (Approve all / Deny all / one row). The shared wire schema, made strict
 * like its siblings here: an unknown field is a 422, never ignored. */
export const adapterGroupDecisionSchema =
  adapterGroupDecisionRequestSchema.strict();

/** POST /channel-adapter/card-stop - a Stop pressed on the narration card
 * (socket arm). The shared wire schema, strict like its siblings here. */
export const adapterCardStopSchema = adapterCardStopRequestSchema.strict();

/** POST /channel-adapter/card-follow-up-action - a control pressed on a
 * waiting message's row of the narration card (socket arm). The shared wire
 * schema, strict like its siblings here. */
export const adapterCardFollowUpActionSchema =
  adapterCardFollowUpActionRequestSchema.strict();

/** POST /channel-adapter/action-decision - a forwarded action-approval-card
 * click (socket arm). Mirrors adapterReachDecisionSchema; the wire schema is
 * the shared truth (agent-protocol). */
export const adapterActionDecisionSchema = z
  .object({
    presenceId: z.string().trim().min(1).max(200),
    approvalId: z.string().trim().min(1).max(500),
    // `approve_always` is the retired "Approve + always allow" (an older
    // adapter may still send it mid-rollout): it settles as `approve`.
    decision: z
      .enum(["approve", "reject", "approve_always"])
      .transform((d) => (d === "reject" ? "reject" : "approve")),
    clickerExternalUserId: z.string().trim().min(1).max(200),
    /** A choice card's picked option. */
    choice: actionChoiceSchema.optional(),
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

/** `?ids=a,b`: the approval ids of cards the adapter saw leave the pending
 * set, as many as the outcome read answers. */
export const adapterPromptOutcomesQuerySchema = z.object({
  ids: z
    .string()
    .transform((s) => s.split(",").filter(Boolean))
    .pipe(z.array(z.string().uuid()).min(1).max(MAX_OUTCOME_IDS)),
});

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

/** The dashboard's action-approval decision — the ONE surface that carries
 * a rejection reason (relayed verbatim to the agent; clamped server-side). */
export const actionApprovalDecisionSchema = z
  .object({
    // `approve_always` is the retired "Approve + always allow" (an older
    // dashboard bundle may still send it mid-deploy): it settles as
    // `approve`.
    decision: z
      .enum(["approve", "reject", "approve_always"])
      .transform((d) => (d === "reject" ? "reject" : "approve")),
    reason: z.string().trim().min(1).max(500).optional(),
    /** A choice card's picked option (e.g. choose-sender: agent | you). */
    choice: actionChoiceSchema.optional(),
  })
  .strict();

/** PUT /agents/:agentId/links/:peerAgentId: THIS agent's side of a pair:
 * Always allow, or Never. A pair with no answer yet asks once, on the first
 * message; Remove (forget) returns it there. */
export const linkPolicySchema = z
  .object({
    policy: z.enum(["allow", "blocked"]),
  })
  .strict();
