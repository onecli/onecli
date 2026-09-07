import { z } from "zod";

/**
 * The CHANNEL-ADAPTER ↔ control-plane wire (hosted-agents v2 step 6).
 *
 * Housed in `@onecli/agent-protocol` the same way `runner-wire.ts` is — the
 * monorepo's shared-zod pattern for a daemon's HTTP contract — though it is
 * NOT agent protocol: nothing here reaches a sandbox, and the sandbox never
 * learns channels exist. The package is simply where both runtimes (the api
 * and the adapter, which carries no DB or api dependency) already meet.
 *
 * Like the runner wire: the control plane answers with these shapes, the
 * adapter zod-parses (never casts) every response.
 */

// ── Registration ────────────────────────────────────────────────────────────

export const adapterRegisterRequestSchema = z.object({
  name: z.string().min(1).max(200),
  /** New binaries send true: "mint me a per-instance credential" (the anchor
   * then only proves membership, it is never this instance's identity). An
   * old control plane's zod strips the unknown key and runs the legacy path —
   * both directions of version skew stay correct. */
  perInstance: z.boolean().optional(),
});
export type AdapterRegisterRequest = z.infer<
  typeof adapterRegisterRequestSchema
>;

export const adapterRegisterResponseSchema = z.object({
  adapterId: z.string().min(1),
  /** Per-instance minted bearer ("cha_" + 64 hex), present only on the
   * mint path. An old control plane never sends it — the client then keeps
   * using the anchor as its bearer (the legacy shared-identity behavior). */
  token: z.string().optional(),
});

// ── The config feed ─────────────────────────────────────────────────────────

export const adapterLinkSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  externalThreadId: z.string(),
  kind: z.enum(["direct", "group"]),
  externalUserId: z.string().nullable(),
  /** ISO timestamp or null — the mirror/catch-up cursor. */
  mirrorCursor: z.string().nullable(),
});
export type AdapterLink = z.infer<typeof adapterLinkSchema>;

export const adapterPresenceSchema = z.object({
  presenceId: z.string(),
  /**
   * Open string, DELIBERATELY not an enum: a provider list baked into a
   * deployed adapter binary would reject the whole config feed (zod throws
   * on the first unknown presence) the day the control plane grows a second
   * provider — bricking the adapter's existing slice, not just the new
   * provider. The adapter instead skips presences whose provider it has no
   * runtime for, loudly. Compile-time safety stays server-side, where the
   * feed is BUILT from the `ChannelProviderId` union.
   */
  provider: z.string(),
  transport: z.enum(["events", "socket"]),
  status: z.string(),
  externalId: z.string(),
  identityRef: z.string().nullable(),
  agent: z.object({
    id: z.string(),
    name: z.string(),
    workspaceId: z.string(),
    /** Public avatar URL (key-fenced), or null. Optional: an older control
     * plane never sends it. */
    imageUrl: z.string().nullable().optional(),
  }),
  tenant: z.object({
    externalId: z.string(),
    name: z.string().nullable(),
  }),
  /** Decrypted provider credential JSON (provider-opaque). */
  credentialsJson: z.string().nullable(),
  /** The gateway approvals key for this presence. */
  approvalsKey: z.string().nullable(),
  links: z.array(adapterLinkSchema),
});
export type AdapterPresence = z.infer<typeof adapterPresenceSchema>;

export const adapterConfigResponseSchema = z.object({
  presences: z.array(adapterPresenceSchema),
  etag: z.string(),
});
export type AdapterConfigResponse = z.infer<typeof adapterConfigResponseSchema>;

// ── The batched work poll ───────────────────────────────────────────────────

export const adapterWorkTurnSchema = z.object({
  id: z.string(),
  status: z.string(),
  source: z.string(),
  userId: z.string().nullable(),
  /** Display name behind `userId`, for cross-surface attribution. Optional:
   * an older control plane never sends it. */
  userName: z.string().nullable().optional(),
  message: z.string(),
  error: z.string().nullable(),
  errorCode: z.string().nullable(),
  /**
   * WHERE THIS TURN WAS ASKED, when it is finer than the link's own address
   * (Slack: the DM thread the person typed in). The answer is posted here
   * rather than at the link's address, so a threaded question is answered in
   * its thread instead of at the bottom of the DM.
   *
   * Provider-opaque; the adapter only hands it back. Optional/nullable for
   * version skew in BOTH directions: an older control plane never sends it,
   * and a turn that arrived at the link's own address leaves it null.
   */
  sourceThreadId: z.string().nullable().optional(),
  /** ISO timestamps. */
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type AdapterWorkTurn = z.infer<typeof adapterWorkTurnSchema>;

export const adapterWorkItemSchema = z.object({
  linkId: z.string(),
  presenceId: z.string(),
  conversationId: z.string(),
  externalThreadId: z.string(),
  kind: z.enum(["direct", "group"]),
  turn: adapterWorkTurnSchema,
  /**
   * Mid-run follow-ups this turn CONSUMED (`joined`), oldest first. The
   * mirror posts the web-sourced ones ahead of the answer so the provider
   * thread shows the same exchange the web does; provider-sourced ones are
   * already in the channel. Optional: an older control plane simply never
   * sends it.
   */
  followUps: z
    .array(
      z.object({
        message: z.string(),
        source: z.string(),
        /** Display name of THIS follow-up's author — on a group thread it
         * can differ from the turn's asker. Optional: an older control plane
         * never sends it (consumers fall back to the turn's name). Null: the
         * control plane resolved and found nothing (deleted user). */
        userName: z.string().nullable().optional(),
      }),
    )
    .optional(),
  /** The link's stored mirror cursor (ISO or null) at the time this item was
   * served — the CAS-seed floor for an instance that acquired the link
   * mid-history with no local cursor. Instance-identity callers' config etag
   * no longer folds cursors (so a mirrored turn stops busting it), and this
   * field is what replaces that seed path. Optional: an older control plane
   * never sends it (those callers still get cursor-busting etags). */
  linkMirrorCursor: z.string().nullable().optional(),
});
export type AdapterWorkItem = z.infer<typeof adapterWorkItemSchema>;

export const adapterWorkResponseSchema = z.object({
  finished: z.array(adapterWorkItemSchema),
});
export type AdapterWorkResponse = z.infer<typeof adapterWorkResponseSchema>;

// ── Ingest (raw provider event → door outcome) ──────────────────────────────

export const adapterIngestRequestSchema = z.object({
  presenceId: z.string().min(1),
  eventId: z.string().min(1).max(500),
  event: z.unknown(),
  // Deliberately NO `email`: the speaker's identity is resolved control-plane
  // -side from the provider event + the presence's own bot token. Letting the
  // caller assert an email would let a compromised adapter impersonate any org
  // member (name the CEO's email → reach their private thread).
});
export type AdapterIngestRequest = z.infer<typeof adapterIngestRequestSchema>;

/** Where the provider-side reply belongs, when one is owed. */
export const adapterReplyTargetSchema = z.object({
  channel: z.string(),
  threadTs: z.string().nullable(),
});

export const adapterIngestResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ignored"), reason: z.string() }),
  z.object({ kind: z.literal("duplicate") }),
  z.object({
    kind: z.literal("refused"),
    message: z.string(),
    reply: adapterReplyTargetSchema.nullable(),
  }),
  /**
   * RETIRED outcome, kept parseable for version skew (a new adapter against
   * an old control plane): a busy conversation now accepts the message as a
   * `followUp` instead of refusing it with a notice.
   */
  z.object({
    kind: z.literal("busy"),
    conversationId: z.string(),
    reply: adapterReplyTargetSchema.nullable(),
  }),
  z.object({
    kind: z.literal("turn"),
    conversationId: z.string(),
    turn: adapterWorkTurnSchema,
    reply: adapterReplyTargetSchema.nullable(),
  }),
  /**
   * The message arrived while a turn was in flight and was accepted as a
   * mid-run follow-up — it steers into the live run or runs next. No text
   * reply is owed; the receipt reaction MOVING to this message is the ack.
   */
  z.object({
    kind: z.literal("followUp"),
    conversationId: z.string(),
    turn: adapterWorkTurnSchema,
    reply: adapterReplyTargetSchema.nullable(),
  }),
  z.object({
    kind: z.literal("invite"),
    outcome: z.enum(["accept", "refuse", "duplicate"]),
    leave: z.boolean(),
    message: z.string().nullable(),
    channel: z.string().nullable(),
  }),
]);
export type AdapterIngestResponse = z.infer<typeof adapterIngestResponseSchema>;

// ── Approvals ───────────────────────────────────────────────────────────────

export const adapterDecisionRequestSchema = z.object({
  presenceId: z.string().min(1),
  approvalId: z.string().min(1).max(500),
  decision: z.enum(["approve", "deny"]),
  clickerExternalUserId: z.string().min(1).max(200),
});
export type AdapterDecisionRequest = z.infer<
  typeof adapterDecisionRequestSchema
>;

export const adapterDecisionResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("decided"), decidedByName: z.string() }),
  z.object({ kind: z.literal("already_settled") }),
  z.object({ kind: z.literal("refused"), message: z.string() }),
  z.object({ kind: z.literal("unavailable"), message: z.string() }),
]);
export type AdapterDecisionResponse = z.infer<
  typeof adapterDecisionResponseSchema
>;

// ── Reach grants (space grants: "answer everyone in this channel") ─────────

export const adapterReachDecisionRequestSchema = z.object({
  presenceId: z.string().min(1),
  grantId: z.string().min(1).max(500),
  /**
   * The settlement the clicker chose: open the channel to everyone in it,
   * keep it to OneCLI users, or keep the agent silent there.
   *
   * The pre-rename `approve`/`deny` pair stays ACCEPTED (never emitted) so
   * a channel-adapter deployable running older code keeps settling grants
   * through a rolling deploy - the adapter and the control plane ship
   * separately, so the wire has to tolerate one being behind. `deny` always
   * meant "OneCLI users only", which is `members_only`.
   */
  decision: z.enum(["approved", "members_only", "blocked", "approve", "deny"]),
  clickerExternalUserId: z.string().min(1).max(200),
});
export type AdapterReachDecisionRequest = z.infer<
  typeof adapterReachDecisionRequestSchema
>;

export const adapterReachDecisionResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("decided"),
    decidedByName: z.string(),
    state: z.string(),
  }),
  z.object({ kind: z.literal("already_settled") }),
  z.object({ kind: z.literal("refused"), message: z.string() }),
]);
export type AdapterReachDecisionResponse = z.infer<
  typeof adapterReachDecisionResponseSchema
>;

export const adapterPromptClaimResponseSchema = z.object({
  claimed: z.boolean(),
});

export const adapterUnsettledPromptSchema = z.object({
  approvalId: z.string(),
  agentChannelId: z.string(),
  externalThreadId: z.string(),
  externalMessageRef: z.string().nullable(),
  /** ISO; the gateway deadline recorded at claim time (null on old rows). */
  expiresAt: z.string().nullable(),
  /** ISO timestamp. */
  createdAt: z.string(),
});
export const adapterUnsettledPromptsResponseSchema = z.object({
  prompts: z.array(adapterUnsettledPromptSchema),
});

export const adapterCursorResponseSchema = z.object({
  advanced: z.boolean(),
});

// ── Transcript (the adapter's read of a linked conversation) ────────────────

export const adapterTranscriptEventSchema = z.object({
  seq: z.number().int(),
  turnId: z.string(),
  type: z.string(),
  payload: z.unknown(),
});
export const adapterTranscriptResponseSchema = z.object({
  events: z.array(adapterTranscriptEventSchema),
  nextSince: z.number().int(),
  hasMore: z.boolean(),
});

// ── Slack text safety (shared by BOTH runtimes on purpose) ──────────────────

/**
 * Make untrusted text inert in Slack `mrkdwn`/`markdown_text`: `<`, `>`, `&`
 * are the ONLY characters Slack treats as syntax openers, and `<!channel>`,
 * `<!here>`, `<@U…>` are live directives — a prompt-injected agent could
 * mass-ping a workspace through its own answer. Every untrusted string
 * (model output, tool output, notices) passes through here before entering
 * ANY Slack payload, in the api's events arm and the adapter alike — which
 * is why the one definition lives in the shared package.
 */
export const escapeSlackText = (raw: string): string =>
  raw.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
