import { z } from "zod";
import {
  APPROVAL_GROUP_ID_RE,
  APPROVAL_GROUP_MAX_IDS,
  FOLLOW_UP_ACTIONS,
} from "@onecli/channels";

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
  /**
   * Where this presence's tool-approval cards go: the id of the link to the
   * approver's OWN direct thread (the owner of the presence's service key,
   * the identity the approvals are decided as). Never a guest's DM or a
   * group thread: a guest can be allowed to TALK to the agent without being
   * able to approve what it does. Null = the approver has no DM with the
   * agent yet, so no card is posted (the approval stays decidable on the
   * web).
   * Optional: an older control plane never sends it, and the adapter then
   * keeps its legacy first-direct-link behavior.
   */
  approvalsLinkId: z.string().nullable().optional(),
});
export type AdapterPresence = z.infer<typeof adapterPresenceSchema>;

export const adapterConfigResponseSchema = z.object({
  presences: z.array(adapterPresenceSchema),
  etag: z.string(),
});
export type AdapterConfigResponse = z.infer<typeof adapterConfigResponseSchema>;

// ── The batched work poll ───────────────────────────────────────────────────

export const adapterOutboundAttachmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  /** The agent's one-line note for the file (Slack: the share's
   * initial_comment). Null when it gave none. */
  caption: z.string().nullable(),
});
export type AdapterOutboundAttachment = z.infer<
  typeof adapterOutboundAttachmentSchema
>;

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
  /**
   * Files the AGENT sent back during this turn (send_file), oldest first —
   * metadata only; the adapter pulls bytes through
   * `GET /channel-adapter/attachments/:id`, fenced to its ownership slice.
   * Strictly the outbound rows: what the person attached to the question is
   * already in the channel. Optional: an older control plane never sends it.
   */
  attachments: z.array(adapterOutboundAttachmentSchema).optional(),
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
   * thread shows the same exchange the web does (an automation's, i.e. a
   * wake that joined a running wake, as its caption, never as a person's
   * words); provider-sourced ones are already in the channel. Each one's
   * own reply, when the agent wrote one, posts right after it. Optional: an
   * older control plane simply never sends it.
   */
  followUps: z
    .array(
      z.object({
        /** The follow-up's own turn id: where its reply is stored in the
         * transcript. Optional: an older control plane never sends it, and
         * the mirror then posts no reply (the pre-field behavior). */
        id: z.string().optional(),
        message: z.string(),
        source: z.string(),
        /** Display name of THIS follow-up's author — on a group thread it
         * can differ from the turn's asker. Optional: an older control plane
         * never sends it (consumers fall back to the turn's name). Null: the
         * control plane resolved and found nothing (deleted user). */
        userName: z.string().nullable().optional(),
        /** Where THIS follow-up was asked, when finer than the link's own
         * address: its reply is posted there (the turn's `sourceThreadId`
         * rule, per message). Optional/nullable for version skew. */
        sourceThreadId: z.string().nullable().optional(),
        /** Whether this follow-up's reply was ALREADY posted, mid-run, by
         * the reply feed (`replies`): the completion pass then posts the
         * follow-up's words (when they came from elsewhere) but not the
         * reply again. Optional: an older control plane never sends it,
         * and never served a reply early either. */
        replyPosted: z.boolean().optional(),
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

/**
 * A reply the agent wrote to a mid-run follow-up of a turn STILL RUNNING,
 * not yet posted to the provider. Everything the mirror needs to post it
 * where the follow-up was asked, without a transcript read of its own: the
 * reply text travels with the item, and so do the follow-up's own words and
 * author, because a follow-up typed on ANOTHER surface (the web) is not in
 * the channel yet and must post ahead of its reply, as one exchange.
 */
export const adapterReplyItemSchema = z.object({
  linkId: z.string(),
  presenceId: z.string(),
  conversationId: z.string(),
  /** The link's own address: the channel the reply posts in. */
  externalThreadId: z.string(),
  kind: z.enum(["direct", "group"]),
  /** The running turn the follow-up joined. */
  turnId: z.string(),
  followUp: z.object({
    id: z.string(),
    /** The follow-up's words, as the completion pass would mirror them. */
    message: z.string(),
    source: z.string(),
    /** The author's display name (null: unnamed), for the attribution line
     * of a follow-up from another surface. */
    userName: z.string().nullable(),
    /** Where the follow-up was asked, when finer than the link's address. */
    sourceThreadId: z.string().nullable(),
  }),
  /** The agent's reply, as stored under the follow-up. */
  reply: z.string(),
});
export type AdapterReplyItem = z.infer<typeof adapterReplyItemSchema>;

export const adapterWorkResponseSchema = z.object({
  finished: z.array(adapterWorkItemSchema),
  /**
   * Replies the agent has ALREADY written to mid-run follow-ups of turns
   * still running, not yet posted to the provider: the mirror posts each
   * one the moment it sees it (claim first, then post), so a person who
   * asked while the agent worked reads the answer while the agent still
   * works. Optional: an older control plane never sends it, and every
   * reply then posts at the turn's close as before.
   */
  replies: z.array(adapterReplyItemSchema).optional(),
});
export type AdapterWorkResponse = z.infer<typeof adapterWorkResponseSchema>;

/** The claim on a follow-up's reply, before it posts: exactly-once by a
 * compare-and-set on the row (NULL to now). */
export const adapterReplyClaimSchema = z.object({
  followUpId: z.string(),
});
export type AdapterReplyClaim = z.infer<typeof adapterReplyClaimSchema>;

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
  /**
   * The provider's native Stop on a thread's loader. The control plane has
   * already done everything shared (the abort, the loader settle); what is
   * left is request-scoped: a refused clicker is owed a note only THEY see,
   * in the thread they clicked in. Null = nothing to say (stopped, or idle).
   */
  z.object({
    kind: z.literal("stop"),
    notice: z
      .object({
        channel: z.string(),
        threadTs: z.string(),
        user: z.string(),
        message: z.string(),
      })
      .nullable(),
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

/** A grouped card's click: Approve all / Deny all, or one row. The ids are
 *  exactly the rows the card showed, in the shared grouped-approval id shape
 *  and cap (@onecli/channels approval-group); the control plane refuses the
 *  whole click unless every id is one of THIS presence's posted cards. */
export const adapterGroupDecisionRequestSchema = z.object({
  presenceId: z.string().min(1),
  approvalIds: z
    .array(z.string().regex(APPROVAL_GROUP_ID_RE))
    .min(1)
    .max(APPROVAL_GROUP_MAX_IDS),
  decision: z.enum(["approve", "deny"]),
  clickerExternalUserId: z.string().min(1).max(200),
});
export type AdapterGroupDecisionRequest = z.infer<
  typeof adapterGroupDecisionRequestSchema
>;

export const adapterGroupDecisionResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("decided"),
    decidedByName: z.string(),
    decided: z.array(z.string()),
    alreadySettled: z.array(z.string()),
    /** Still pending (the gateway call failed): the card keeps them. */
    failed: z.array(z.string()),
  }),
  z.object({ kind: z.literal("refused"), message: z.string() }),
  z.object({ kind: z.literal("unavailable"), message: z.string() }),
]);
export type AdapterGroupDecisionResponse = z.infer<
  typeof adapterGroupDecisionResponseSchema
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

// ── Action approvals (one-shot holds: "may I do this specific thing?") ─────

export const adapterActionDecisionRequestSchema = z.object({
  presenceId: z.string().min(1),
  approvalId: z.string().min(1).max(500),
  // `approve_always` (4c): approve AND record the standing grant. An older
  // control plane rejects it at the schema and the adapter logs the miss —
  // the card click degrades loudly, never silently.
  decision: z.enum(["approve", "approve_always", "reject"]),
  clickerExternalUserId: z.string().min(1).max(200),
});
export type AdapterActionDecisionRequest = z.infer<
  typeof adapterActionDecisionRequestSchema
>;

/** Forward-only from the adapter's side: the control plane authorizes the
 * clicker, flips the row, executes, and rewrites every posted card itself
 * (cardRefs) — the adapter owes the wire nothing further. The response
 * exists for logging and version-skew detection only. */
export const adapterActionDecisionResponseSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("decided"), status: z.string() }),
    z.object({ kind: z.literal("already_settled") }),
    z.object({ kind: z.literal("refused"), message: z.string() }),
  ],
);
export type AdapterActionDecisionResponse = z.infer<
  typeof adapterActionDecisionResponseSchema
>;

// ── Card Stop (the narration card's own Stop button) ──────────────────────────

/**
 * A Stop pressed on the narration card, relayed by the socket arm. Carries
 * only where the provider says the card sits and who pressed it; the
 * control plane resolves the turn whose LIVE card that is on this presence
 * and authorizes the clicker itself.
 */
export const adapterCardStopRequestSchema = z.object({
  presenceId: z.string().min(1),
  channel: z.string().min(1).max(200),
  cardTs: z.string().min(1).max(200),
  clickerExternalUserId: z.string().min(1).max(200),
});
export type AdapterCardStopRequest = z.infer<
  typeof adapterCardStopRequestSchema
>;

/** `refused` is owed to the clicker alone (the adapter posts it
 * ephemerally); `stopped` / `idle` owe nothing (the turn's close replaces
 * the card with "Stopped."). */
export const adapterCardStopResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stopped") }),
  z.object({ kind: z.literal("idle") }),
  z.object({ kind: z.literal("refused"), message: z.string() }),
]);
export type AdapterCardStopResponse = z.infer<
  typeof adapterCardStopResponseSchema
>;

// ── Card row action (a control on a waiting message's row of the card) ───────

/**
 * A control pressed on a waiting message's row of the narration card,
 * relayed by the socket arm: where the provider says the card sits, which
 * row was pressed, and who pressed it. The row id is a pointer the control
 * plane checks against the card's own turn, never an authority.
 */
export const adapterCardFollowUpActionRequestSchema = z.object({
  presenceId: z.string().min(1),
  channel: z.string().min(1).max(200),
  cardTs: z.string().min(1).max(200),
  clickerExternalUserId: z.string().min(1).max(200),
  action: z.enum(FOLLOW_UP_ACTIONS),
  followUpId: z.string().min(1).max(200),
});
export type AdapterCardFollowUpActionRequest = z.infer<
  typeof adapterCardFollowUpActionRequestSchema
>;

/** `refused` is owed to the clicker alone (the adapter posts it
 * ephemerally); `done` owes nothing (the row leaves the card once the agent
 * reads the message). */
export const adapterCardFollowUpActionResponseSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("done") }),
    z.object({ kind: z.literal("refused"), message: z.string() }),
  ],
);
export type AdapterCardFollowUpActionResponse = z.infer<
  typeof adapterCardFollowUpActionResponseSchema
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

/** The answer to a reply claim: true on the winning compare-and-set. */
export const adapterReplyClaimResponseSchema = z.object({
  claimed: z.boolean(),
});

// ── Outbound mentions (the completion pass's name resolution) ───────────────
// The model writes `@[Name]`; the ADAPTER asks the control plane to resolve
// the names before posting (the directory — linked teammates — is
// control-plane data), then reports what could not resolve so the next
// turn's context can tell the model. Names travel NORMALIZED (the
// `normalizeMentionName` form): both sides compare on the canonical form,
// so the wire never carries two spellings of one name.

export const adapterMentionResolveRequestSchema = z.object({
  presenceId: z.string(),
  /** The conversation whose mention ANCHORS apply (a find_recipient pick:
   * name → provider user id, conversation-scoped). Optional for wire
   * compatibility with an older adapter; without it resolution is
   * directory-only, exactly the pre-anchor behavior. */
  conversationId: z.string().optional(),
  /** Distinct normalized names (`mentionNamesOf` output), capped client-side
   * by the scanner; the route re-caps — neither side trusts the other's
   * bound. */
  names: z.array(z.string().trim().min(1).max(80)).max(20),
});
export type AdapterMentionResolveRequest = z.infer<
  typeof adapterMentionResolveRequestSchema
>;

export const adapterMentionResolutionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("resolved"),
    name: z.string(),
    /** The provider-native user id (Slack: `U…`/`W…`) the PLATFORM verified
     * for this name — the one identity source the renderer may emit. */
    externalUserId: z.string(),
    /** The linked person's platform display name, for the failure/success
     * note ("resolved to Dan Abramov"). */
    displayName: z.string(),
  }),
  z.object({
    kind: z.literal("ambiguous"),
    name: z.string(),
    /** Display names of the colliding links — the note's "did you mean". */
    candidates: z.array(z.string()),
  }),
  z.object({ kind: z.literal("unknown"), name: z.string() }),
]);
export type AdapterMentionResolution = z.infer<
  typeof adapterMentionResolutionSchema
>;

export const adapterMentionResolveResponseSchema = z.object({
  resolutions: z.array(adapterMentionResolutionSchema),
});

export const adapterMentionReportRequestSchema = z.object({
  /** The turn whose answer carried the failures — the note rides the NEXT
   * turn of the same conversation. */
  turnId: z.string(),
  failures: z.array(
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("ambiguous"),
        /** The name as the model wrote it (trimmed), for a note the model
         * can match to its own output. */
        name: z.string().max(80),
        candidates: z.array(z.string().max(80)).max(10),
      }),
      z.object({ kind: z.literal("unknown"), name: z.string().max(80) }),
      /** Plain `@name` prose that MATCHED a linked teammate but was not
       * written as `@[name]` — it pinged nobody, and the model most likely
       * believed it did (the exact false belief the loud-failure rule
       * exists to kill). Reported so the next turn's note can correct the
       * habit with the specific fix: write `@[name]`. */
      z.object({ kind: z.literal("near_miss"), name: z.string().max(80) }),
    ]),
  ),
});
export type AdapterMentionReportRequest = z.infer<
  typeof adapterMentionReportRequestSchema
>;

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

// ── Slack text safety ───────────────────────────────────────────────────────
// `escapeSlackText` MOVED to @onecli/channels/slack (the Slack text layer,
// beside the clamps it composes with) - every consumer was Slack-shaped and
// this package is the agent<->runner wire, not a provider home. Re-exported
// for one release so downstream imports do not churn; new code imports from
// @onecli/channels/slack.
export { escapeSlackText } from "@onecli/channels/slack";
