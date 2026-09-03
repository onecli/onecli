import { db, Prisma } from "@onecli/db";
import { getCrypto } from "../../providers";
import { ServiceError } from "../errors";
import { canAccessWorkspaceAsUser } from "../workspace-access-check";
import {
  ensureDirectConversation,
  ensureSourcedConversation,
} from "../conversation-service";
import { createTurn } from "../turn-service";
import { sendConversationMessage } from "../follow-up-service";
import {
  createFailedAttachment,
  createPendingAttachment,
} from "../attachment-service";
import { channelProvider } from "./registry";
import type {
  ChannelFileRef,
  ChannelProviderId,
  ThreadLinkKind,
} from "./types";
import { logger } from "../../lib/logger";
// Type-only: the runtime import of the reach service stays dynamic (below)
// so this hot ingestion path does not eagerly pull the reach module graph.
import type { ReachState } from "./agent-reach-service";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_ROWS_PER_MESSAGE,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "@onecli/agent-protocol";

const log = logger.child({ component: "channel-ingestion" });

/**
 * THE INGESTION DOORS — where a provider event becomes (or is refused) a
 * turn. The whole fence lives here, control-plane-side: the adapter and the
 * inbound routes only relay what the provider delivered plus which presence
 * it belongs to; they never decide authorization (§3.16 — authorization is
 * enforced on our side of the socket).
 *
 * Two laws every door obeys:
 *
 * 1. **Idempotent by event id.** Providers deliver at least once (unacked
 *    envelopes are retried, reconnects replay, webhooks re-POST) and adapter
 *    memory dies with its process — so the dedupe is a DATABASE insert, first
 *    thing: a P2002 on `channel_ingested_events` means "already ingested" and
 *    the door answers `duplicate` without side effects. Insert-FIRST is a
 *    deliberate at-most-once choice: a crash between the insert and the turn
 *    loses one message (the user retypes — the same failure a crashed web
 *    send has), whereas insert-last would double-answer on redelivery, which
 *    costs money and reads as a malfunction.
 *
 * 2. **Agent-authored events are refused**, defense-in-depth behind the
 *    adapter's own echo guard — the bot hearing its own answer must never
 *    become a turn, or the first reply loops forever.
 */

/** Keep dedupe rows for a day — far past any provider's redelivery window. */
const INGESTED_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;

export type IngestOutcome =
  | { kind: "duplicate" }
  | { kind: "ignored"; reason: string }
  | { kind: "refused"; message: string }
  | {
      kind: "turn";
      conversationId: string;
      turn: Awaited<ReturnType<typeof createTurn>>;
    }
  | {
      /** Accepted mid-run: the message steers into the live turn (or runs
       * next). The ack is the seen-mark moving (the reaction travels; a
       * session loader already covers the thread) — no text is owed. */
      kind: "followUp";
      conversationId: string;
      turn: Awaited<ReturnType<typeof createTurn>>;
    };

const refusalNotLinked = (provider: ChannelProviderId): string =>
  `I couldn't match your ${channelProvider(provider).displayName} account to a OneCLI user, so I can't help here yet. Ask an org admin to link your account under the organization's Channels settings.`;

const REFUSAL_NO_ACCESS =
  "Your OneCLI account doesn't have access to my workspace, so I can't help here. Ask a workspace admin to grant you access in the dashboard.";

const presenceSelect = {
  id: true,
  provider: true,
  identityRef: true,
  integrationId: true,
  credentials: true,
  // The tenant id rides along for the guest lane's same-tenant fence.
  integration: { select: { externalId: true } },
  agent: {
    select: {
      id: true,
      name: true,
      workspaceId: true,
      workspace: { select: { id: true, organizationId: true } },
    },
  },
} as const;

type PresenceRow = Prisma.AgentChannelGetPayload<{
  select: typeof presenceSelect;
}>;

const requirePresence = async (
  agentChannelId: string,
): Promise<PresenceRow> => {
  const presence = await db.agentChannel.findUnique({
    where: { id: agentChannelId },
    select: presenceSelect,
  });
  if (!presence) throw new ServiceError("NOT_FOUND", "Unknown presence");
  return presence;
};

/**
 * The at-least-once dedupe. True = first sight; false = redelivery.
 * Opportunistically prunes this presence's old rows so the table stays a
 * working set, not a log.
 */
const recordEventOnce = async (
  agentChannelId: string,
  eventId: string,
): Promise<boolean> => {
  try {
    await db.channelIngestedEvent.create({
      data: { agentChannelId, eventId },
      select: { id: true },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return false;
    }
    throw err;
  }
  // Fire-and-forget prune: losing one pass costs nothing.
  db.channelIngestedEvent
    .deleteMany({
      where: {
        agentChannelId,
        createdAt: {
          lt: new Date(Date.now() - INGESTED_EVENT_RETENTION_MS),
        },
      },
    })
    .catch((err: unknown) =>
      log.warn({ err, agentChannelId }, "ingested-event prune failed"),
    );
  return true;
};

/**
 * Provider user → platform user, and the access fence in one place.
 *
 * The mapping: an existing `ChannelUserLink`, else a verified-email match
 * (minting an `email` link lazily; races on the unique re-read the winner).
 * Email trust: provider emails are provider-verified (Slack verifies account
 * emails), and the blast radius of a mistaken match is bounded by the fences
 * below — but self-host local-auth `User.email` is only as verified as the
 * operator made it, which is why the explicit manual link always exists.
 *
 * The fence is TWO checks, deliberately:
 * - active membership of the integration's org — `canAccessWorkspaceAsUser`
 *   alone answers true for everyone on non-RBAC self-host (the flat team),
 *   and a flat team is still not "any User row whose email matched";
 * - the shared workspace-access predicate (RBAC deployments: admin or binding).
 */
export const authorizeChannelUser = async (
  integrationId: string,
  organizationId: string,
  workspace: { id: string; organizationId: string },
  externalUserId: string,
  email?: string,
): Promise<{ userId: string } | null> => {
  const link = await db.channelUserLink.findUnique({
    where: {
      integrationId_externalUserId: { integrationId, externalUserId },
    },
    select: { userId: true },
  });

  let userId = link?.userId ?? null;

  if (!userId && email) {
    const user = await db.user.findUnique({
      where: { email },
      select: { id: true },
    });
    // Only a live org member earns a link. Minting first would leave residue
    // for a foreign or suspended user whose email happened to match — and
    // downgrade their refusal from the actionable "not linked" to a puzzling
    // "no access" on every later message.
    const eligible =
      user &&
      (await db.organizationMember.findFirst({
        where: {
          organizationId,
          userId: user.id,
          NOT: { status: "suspended" },
        },
        select: { userId: true },
      }));
    if (user && eligible) {
      try {
        await db.channelUserLink.create({
          data: {
            integrationId,
            externalUserId,
            userId: user.id,
            linkedVia: "email",
          },
          select: { id: true },
        });
      } catch (err) {
        if (
          !(
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === "P2002"
          )
        ) {
          throw err;
        }
        // Lost a race (or the user is already linked under another Slack id
        // — the (integration, user) unique): re-read what won.
        const winner = await db.channelUserLink.findUnique({
          where: {
            integrationId_externalUserId: { integrationId, externalUserId },
          },
          select: { userId: true },
        });
        if (!winner) return null;
        userId = winner.userId;
      }
      userId ??= user.id;
    }
  }

  if (!userId) return null;

  const membership = await db.organizationMember.findFirst({
    where: { organizationId, userId, NOT: { status: "suspended" } },
    select: { userId: true },
  });
  if (!membership) return null;

  const allowed = await canAccessWorkspaceAsUser(userId, workspace);
  return allowed ? { userId } : null;
};

const authorizeSpeaker = async (
  presence: PresenceRow,
  externalUserId: string,
): Promise<{ userId: string } | { refusal: string }> => {
  // The speaker's email is resolved HERE, control-plane-side — never accepted
  // from the caller (that would be an impersonation vector). Lazy lookup only
  // when no link exists yet: the provider owns HOW (Slack: users.info with the
  // presence's own bot token).
  let resolvedEmail: string | undefined;
  {
    const existing = await db.channelUserLink.findUnique({
      where: {
        integrationId_externalUserId: {
          integrationId: presence.integrationId,
          externalUserId,
        },
      },
      select: { id: true },
    });
    if (!existing) {
      const credentialsJson = presence.credentials
        ? await getCrypto().decrypt(presence.credentials)
        : null;
      resolvedEmail = await channelProvider(
        presence.provider as ChannelProviderId,
      ).lookupUserEmail({ credentialsJson, externalUserId });
    }
  }

  const authorized = await authorizeChannelUser(
    presence.integrationId,
    presence.agent.workspace.organizationId,
    presence.agent.workspace,
    externalUserId,
    resolvedEmail,
  );
  if (authorized) return authorized;

  // Two refusals, one distinction the person can act on: "we don't know who
  // you are" vs "we know you, and you don't have access".
  const linked = await db.channelUserLink.findUnique({
    where: {
      integrationId_externalUserId: {
        integrationId: presence.integrationId,
        externalUserId,
      },
    },
    select: { id: true },
  });
  return {
    refusal: linked
      ? REFUSAL_NO_ACCESS
      : refusalNotLinked(presence.provider as ChannelProviderId),
  };
};

const upsertThreadLink = async (input: {
  agentChannelId: string;
  conversationId: string;
  externalThreadId: string;
  kind: ThreadLinkKind;
  externalUserId: string | null;
}): Promise<void> => {
  await db.channelThreadLink.upsert({
    where: {
      agentChannelId_externalThreadId: {
        agentChannelId: input.agentChannelId,
        externalThreadId: input.externalThreadId,
      },
    },
    create: input,
    // Repoint on re-link: if an admin re-maps this Slack user to a different
    // platform user, `ensureDirectConversation` now resolves a DIFFERENT
    // conversation, and the link must follow it — otherwise the new user's
    // turns land in an unlinked conversation (invisible in Slack) while the
    // mirror keeps posting the OLD user's web activity into this DM, a
    // cross-user leak. A same-user repeat writes the same values (a no-op).
    update: {
      conversationId: input.conversationId,
      externalUserId: input.externalUserId,
    },
  });
};

/**
 * Fetch a message's files with the presence's credential and store them as
 * attachment rows — called ONLY after `recordEventOnce` (the dedupe means a
 * provider redelivery can never double-download) and `authorizeSpeaker` (an
 * unauthorized user's files are never fetched; the order is a security
 * property, not a style choice). Per-file failures become byteless `failed`
 * rows so the turn can say what happened; files past the per-message cap are
 * refused the same visible way.
 */
const ingestMessageFiles = async (
  presence: PresenceRow,
  conversationId: string,
  // Null = guest-shared files (an approved space grant): stored and bound
  // with no uploader attribution, same caps as members.
  userId: string | null,
  files: ChannelFileRef[],
): Promise<string[] | undefined> => {
  if (files.length === 0) return undefined;

  const credentialsJson = presence.credentials
    ? await getCrypto().decrypt(presence.credentials)
    : null;
  const provider = channelProvider(presence.provider as ChannelProviderId);
  const ids: string[] = [];

  // Bounded by the ROW cap, not the deliverable cap: surplus files still get
  // a byteless `failed` row (so the person is told), and the bind tolerates
  // those — but the id array must stay bounded whatever a provider sends.
  for (const [index, file] of files
    .slice(0, MAX_ATTACHMENT_ROWS_PER_MESSAGE)
    .entries()) {
    try {
      if (index >= MAX_ATTACHMENTS_PER_MESSAGE) {
        const refused = await createFailedAttachment({
          conversationId,
          userId,
          source: presence.provider,
          name: file.name ?? "file",
          mimeType: file.mimeType ?? "application/octet-stream",
          sizeBytes: file.size ?? 0,
          error: `over the ${MAX_ATTACHMENTS_PER_MESSAGE}-file limit`,
        });
        ids.push(refused.id);
        continue;
      }
      const fetched = await provider.fetchAttachment({
        credentialsJson,
        file,
        maxBytes: MAX_ATTACHMENT_BYTES,
      });
      const stored = fetched.ok
        ? await createPendingAttachment({
            conversationId,
            userId,
            source: presence.provider,
            name: fetched.name,
            mimeType: fetched.mimeType,
            bytes: fetched.bytes,
          })
        : await createFailedAttachment({
            conversationId,
            userId,
            source: presence.provider,
            name: fetched.name,
            mimeType: fetched.mimeType,
            sizeBytes: fetched.sizeBytes,
            error: fetched.reason,
          });
      ids.push(stored.id);
    } catch (err) {
      // One broken file must not silently eat the message (or its siblings).
      // Record the refusal so the person still sees WHY it is missing — a
      // fetched-but-unstorable file (the pending cap, a store outage) would
      // otherwise vanish with no chip and no context-note mention. If even
      // that write fails, warn and move on.
      log.warn(
        { err: String(err), fileId: file.id, conversationId },
        "attachment ingest failed; recording it as unavailable",
      );
      try {
        const recorded = await createFailedAttachment({
          conversationId,
          userId,
          source: presence.provider,
          name: file.name ?? "file",
          mimeType: file.mimeType ?? "application/octet-stream",
          sizeBytes: file.size ?? 0,
          error: "could not be stored",
        });
        ids.push(recorded.id);
      } catch (inner) {
        log.warn(
          { err: String(inner), fileId: file.id, conversationId },
          "could not even record the failed attachment; dropping it",
        );
      }
    }
  }
  return ids.length > 0 ? ids : undefined;
};

const createTurnOutcome = async (
  presence: PresenceRow,
  conversationId: string,
  message: string,
  // Null = a GUEST speaker admitted by an approved space grant: no platform
  // identity to attribute, the framed prefix carries who spoke.
  userId: string | null,
  attachmentIds?: string[],
  sourceThreadId?: string | null,
): Promise<IngestOutcome> => {
  try {
    const sent = await sendConversationMessage(
      presence.agent.workspaceId,
      conversationId,
      message,
      {
        source: presence.provider as ChannelProviderId,
        userId,
        // Where the person actually typed, when the surface says so — the
        // completion pass answers there instead of at the link's one address.
        ...(sourceThreadId != null && { sourceThreadId }),
      },
      attachmentIds,
    );
    // "busy" retired: a mid-run message is ACCEPTED as a follow-up (it
    // steers into the live turn or runs next) instead of refused with a
    // notice nothing honored. The one refusal left is the follow-up cap,
    // which surfaces as `refused` below — visibly, on purpose.
    return sent.kind === "turn"
      ? { kind: "turn", conversationId, turn: sent.turn }
      : { kind: "followUp", conversationId, turn: sent.turn };
  } catch (err) {
    if (err instanceof ServiceError && err.code === "CONFLICT") {
      return { kind: "refused", message: err.message };
    }
    throw err;
  }
};

/**
 * Strip control characters and clamp — the speaker prefix goes inside the
 * turn message, and a name is not a place for terminal escapes. Built from
 * char codes rather than a regex range so no literal control byte has to
 * appear in this source file.
 */
const cleanName = (raw: string): string =>
  [...raw]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim()
    .slice(0, 80);

export interface DirectMessageInput {
  agentChannelId: string;
  externalUserId: string;
  /** The provider's own thread address for the DM (Slack: the IM channel). */
  externalThreadId: string;
  text: string;
  /** Files shared with the message (metadata refs; fetched after authorize). */
  files?: ChannelFileRef[];
  /**
   * The THREAD inside the DM this message was typed in, when there is one
   * (Slack: `thread_ts`). The conversation is unchanged — a DM is one
   * continuous thread (§3.18) — but the answer is owed where it was asked,
   * and a DM link addresses only the DM itself.
   */
  sourceThreadId?: string | null;
  eventId: string;
}

export const ingestDirectMessage = async (
  input: DirectMessageInput,
): Promise<IngestOutcome> => {
  const presence = await requirePresence(input.agentChannelId);

  if (presence.identityRef && input.externalUserId === presence.identityRef) {
    return { kind: "ignored", reason: "agent-authored" };
  }
  if (!(await recordEventOnce(presence.id, input.eventId))) {
    return { kind: "duplicate" };
  }

  // Lane 1 - IDENTITY, first and unchanged. Note the deliberate ASYMMETRY
  // with the group door: there the grant is a precondition that holds even
  // members, because a channel is one shared room with one policy. A DM is
  // nobody's shared room - holding a linked teammate's own DM pending would
  // be nonsense - so here identity wins and the person grant is the
  // fallback for people identity cannot place.
  const speaker = await authorizeSpeaker(presence, input.externalUserId);
  if ("refusal" in speaker) {
    // Lane 2 - PERSON REACH: the knock. Admits an approved stranger as a
    // guest, answers the waiting line while their request is out, and
    // stays silent for a blocked person. Null = no person lane applies and
    // the identity refusal stands.
    const person = await tryPersonLane(presence, input);
    if (person) return person;
    return { kind: "refused", message: speaker.refusal };
  }

  const conversation = await ensureDirectConversation(
    presence.agent.workspaceId,
    presence.agent.id,
    speaker.userId,
    presence.provider as ChannelProviderId,
  );
  await upsertThreadLink({
    agentChannelId: presence.id,
    conversationId: conversation.id,
    externalThreadId: input.externalThreadId,
    kind: "direct",
    externalUserId: input.externalUserId,
  });

  const attachmentIds = await ingestMessageFiles(
    presence,
    conversation.id,
    speaker.userId,
    input.files ?? [],
  );

  return createTurnOutcome(
    presence,
    conversation.id,
    input.text,
    speaker.userId,
    attachmentIds,
    input.sourceThreadId,
  );
};

/**
 * Lane 2 of the DM door - the PERSON knock.
 *
 * Runs only after the identity lane refused, and answers:
 *   approved -> admit them as a guest (below);
 *   pending  -> the waiting line (their request is with the owner);
 *   blocked  -> silence, the settled "no";
 *   no row   -> plant it, post the owner cards, answer the waiting line.
 *
 * Fails CLOSED to null ("let the identity refusal stand") for everything it
 * cannot govern: a provider with no reach facet, an unverifiable speaker, or
 * a foreign-tenant one (the same-tenant fence the space lane uses).
 *
 * `members_only` is deliberately NOT a person settlement - it says nothing
 * about one individual - but a row carrying it (hand-set, or normalized
 * from a legacy `denied`) reads as "not this person", which is the honest
 * reading of the pre-rename word.
 */
const tryPersonLane = async (
  presence: PresenceRow,
  input: DirectMessageInput,
): Promise<IngestOutcome | null> => {
  const providerId = presence.provider as ChannelProviderId;
  const reach = channelProvider(providerId).reach;
  if (!reach) return null;

  const {
    ensurePersonGrant,
    resolvePersonReach,
    postReachCards,
    pendingReachMessage,
  } = await import("./agent-reach-service");

  let state = await resolvePersonReach({
    agentId: presence.agent.id,
    integrationId: presence.integrationId,
    externalRef: input.externalUserId,
  });

  if (state === null) {
    // First contact: verify the speaker BEFORE planting anything, so a
    // foreign-tenant or unverifiable stranger never creates a row or a
    // card. This ordering is the fence - not a style choice.
    const credentialsJson = presence.credentials
      ? await getCrypto().decrypt(presence.credentials)
      : null;
    const probe = await reach.resolveGuestSpeaker({
      credentialsJson,
      externalUserId: input.externalUserId,
      tenantExternalId: presence.integration.externalId,
    });
    if (!probe || !probe.sameTenant) return null;

    const label = reach.personLabel
      ? await reach
          .personLabel({ credentialsJson, externalRef: input.externalUserId })
          .catch(() => null)
      : null;
    const grant = await ensurePersonGrant({
      agentId: presence.agent.id,
      integrationId: presence.integrationId,
      provider: providerId,
      externalRef: input.externalUserId,
      subjectLabel: label,
    });
    if (grant.created) {
      // Detached: card posting must never delay or fail the answer.
      void postReachCards(grant.id).catch((err: unknown) =>
        log.warn({ err, grantId: grant.id }, "person reach card post failed"),
      );
    }
    state = grant.state;
  }

  if (state === "approved") return admitPersonGuest(presence, input);
  if (state === "pending") {
    return {
      kind: "refused",
      message: await pendingReachMessage({
        agentId: presence.agent.id,
        workspaceId: presence.agent.workspaceId,
      }),
    };
  }
  // blocked / members_only (incl. legacy denied|revoked): a settled no. The
  // person already heard the identity refusal once when they first wrote;
  // repeating it forever would be nagging, so the agent simply stops.
  return { kind: "ignored", reason: "person-reach-denied" };
};

/**
 * Admit one approved person's DM as a GUEST turn.
 *
 * The conversation is SOURCED (keyed by the DM address), never the direct
 * per-user row: `ensureDirectConversation` is keyed on a platform `userId`
 * a guest does not have, direct rows are unique per user, and the adapter
 * mirror pushes a user's web activity into their linked DM - so seating a
 * guest in a direct row would leak another person's activity to them.
 *
 * Same posture as the channel guest lane: `userId: null` (no identity to
 * attribute), our own "(guest)" framing around a cleaned, clamped name, and
 * attachments under the same caps as members.
 */
const admitPersonGuest = async (
  presence: PresenceRow,
  input: DirectMessageInput,
): Promise<IngestOutcome> => {
  const providerId = presence.provider as ChannelProviderId;
  const reach = channelProvider(providerId).reach;
  if (!reach) return { kind: "ignored", reason: "no-reach-facet" };

  const credentialsJson = presence.credentials
    ? await getCrypto().decrypt(presence.credentials)
    : null;
  // Re-verified on EVERY message, not just at the knock: a grant is not a
  // standing waiver of the tenant fence, and an account that left the
  // workspace (or turned out to be a Connect guest) must stop being
  // answered even though the row still says approved.
  const guest = await reach.resolveGuestSpeaker({
    credentialsJson,
    externalUserId: input.externalUserId,
    tenantExternalId: presence.integration.externalId,
  });
  if (!guest) return { kind: "ignored", reason: "guest-unverifiable" };
  if (!guest.sameTenant)
    return { kind: "ignored", reason: "guest-foreign-tenant" };

  const conversation = await ensureSourcedConversation(
    presence.agent.workspaceId,
    presence.agent.id,
    { source: providerId, externalRef: input.externalThreadId },
  );
  await upsertThreadLink({
    agentChannelId: presence.id,
    conversationId: conversation.id,
    externalThreadId: input.externalThreadId,
    kind: "direct",
    // No platform identity to route by - and critically NOT the guest's
    // provider id, which would make this link look like a linked member's
    // DM to anything that reads `externalUserId`.
    externalUserId: null,
  });

  const speakerName = cleanName(guest.displayName ?? "someone");
  const attachmentIds = await ingestMessageFiles(
    presence,
    conversation.id,
    null,
    input.files ?? [],
  );

  return createTurnOutcome(
    presence,
    conversation.id,
    `${speakerName} (guest): ${input.text}`,
    null,
    attachmentIds,
    input.sourceThreadId,
  );
};

export interface GroupMessageInput {
  agentChannelId: string;
  externalUserId: string;
  /** Provider-defined group-thread address (Slack: `<channel>:<threadTs>`). */
  externalThreadId: string;
  /** Human title for the conversation row (Slack: `#channel-name`). */
  title: string | null;
  text: string;
  /** Files shared with the message (metadata refs; fetched after authorize). */
  files?: ChannelFileRef[];
  eventId: string;
}

export const ingestGroupMessage = async (
  input: GroupMessageInput,
): Promise<IngestOutcome> => {
  const presence = await requirePresence(input.agentChannelId);

  if (presence.identityRef && input.externalUserId === presence.identityRef) {
    return { kind: "ignored", reason: "agent-authored" };
  }
  if (!(await recordEventOnce(presence.id, input.eventId))) {
    return { kind: "duplicate" };
  }

  // THE CHANNEL GATE, first and for everyone. The grant is a PRECONDITION
  // for the channel, not a fallback for strangers: until a human settles
  // how this agent should behave here, nobody is answered - not a guest,
  // not a workspace member, not the owner who invited the bot. The room
  // hears one consistent thing ("waiting on approval") instead of the
  // agent chatting with some people while telling others it can't help,
  // which is what made the old ordering read as a bug.
  const gate = await checkChannelGate(presence, input);
  if (gate.kind !== "open") return gate.outcome;

  // Lane 1 - IDENTITY: a workspace-authorized platform user. Runs inside an
  // open channel; nothing in the reach ledger ever narrows it.
  const speaker = await authorizeSpeaker(presence, input.externalUserId);
  if ("refusal" in speaker) {
    // Lane 2 - SPACE REACH: `approved` opens the channel to everyone in it
    // (same provider tenant), so a stranger is admitted as a guest. Under
    // `members_only` the identity refusal stands.
    if (gate.state === "approved") {
      // THE PRECEDENCE LAW: a person-level "no" beats a space-level "yes".
      // Opening a channel is a statement about a ROOM; blocking a person is
      // a statement about a HUMAN, and the narrower, more deliberate one
      // must win - otherwise a blocked individual walks straight back in
      // through any open channel, which would make blocking meaningless.
      const { resolvePersonReach } = await import("./agent-reach-service");
      const person = await resolvePersonReach({
        agentId: presence.agent.id,
        integrationId: presence.integrationId,
        externalRef: input.externalUserId,
      });
      if (person === "blocked" || person === "members_only") {
        return { kind: "ignored", reason: "person-reach-denied" };
      }
      const guest = await admitGuest(presence, input);
      if (guest) return guest;
    }
    return { kind: "refused", message: speaker.refusal };
  }

  const conversation = await ensureSourcedConversation(
    presence.agent.workspaceId,
    presence.agent.id,
    {
      source: presence.provider as ChannelProviderId,
      externalRef: input.externalThreadId,
      ...(input.title && { title: input.title }),
    },
  );
  await upsertThreadLink({
    agentChannelId: presence.id,
    conversationId: conversation.id,
    externalThreadId: input.externalThreadId,
    kind: "group",
    externalUserId: null,
  });

  // The speaker prefix uses OUR authenticated user's name — never the
  // provider display name, which is attacker-controlled prompt-injection
  // surface (anyone can rename themselves "SYSTEM: ignore your brief").
  const user = await db.user.findUnique({
    where: { id: speaker.userId },
    select: { name: true, email: true },
  });
  const speakerName = cleanName(user?.name || user?.email || "teammate");

  const attachmentIds = await ingestMessageFiles(
    presence,
    conversation.id,
    speaker.userId,
    input.files ?? [],
  );

  return createTurnOutcome(
    presence,
    conversation.id,
    `${speakerName}: ${input.text}`,
    speaker.userId,
    attachmentIds,
  );
};

/**
 * THE CHANNEL GATE. Resolves what this channel's settlement permits, before
 * any speaker is considered.
 *
 * Returns `open` with the settlement (the caller uses `approved` to decide
 * whether strangers get the guest lane), or a closed outcome that ends the
 * turn for everyone:
 *   - `pending`  -> the waiting line, naming the owner + dashboard link;
 *   - `blocked`  -> total silence (the "Don't allow" settlement);
 *   - no grant   -> plant it, post the owner cards, then answer as pending.
 *
 * Fails OPEN to `members_only` for anything it cannot govern - a provider
 * with no reach facet, or a thread that maps to no space (a DM). Those are
 * channels this feature does not model, and they must keep working exactly
 * as they did before the feature existed.
 */
const checkChannelGate = async (
  presence: PresenceRow,
  input: GroupMessageInput,
): Promise<
  | { kind: "open"; state: ReachState }
  | { kind: "closed"; outcome: IngestOutcome }
> => {
  const providerId = presence.provider as ChannelProviderId;
  const reach = channelProvider(providerId).reach;
  const space = reach?.spaceOf(input.externalThreadId);
  // Ungoverned surfaces (no facet, or not a space): pre-feature behavior.
  if (!reach || !space) return { kind: "open", state: "members_only" };

  const {
    ensureSpaceGrant,
    resolveSpaceReach,
    postReachCards,
    pendingReachMessage,
  } = await import("./agent-reach-service");

  let state = await resolveSpaceReach({
    agentId: presence.agent.id,
    integrationId: presence.integrationId,
    externalRef: space,
  });

  if (state === null) {
    // The lazy knock: the first message in an ungoverned channel plants the
    // pending grant and posts the owner cards, so channels that predate the
    // feature (or missed the invite hook) heal without a re-invite.
    const credentialsJson = presence.credentials
      ? await getCrypto().decrypt(presence.credentials)
      : null;
    const label = await reach
      .spaceLabel({ credentialsJson, externalRef: space })
      .catch(() => null);
    const grant = await ensureSpaceGrant({
      agentId: presence.agent.id,
      integrationId: presence.integrationId,
      provider: providerId,
      externalRef: space,
      subjectLabel: label,
    });
    if (grant.created) {
      // Detached: card posting must never delay or fail the ingest answer.
      void postReachCards(grant.id).catch((err: unknown) =>
        log.warn({ err, grantId: grant.id }, "reach card post failed"),
      );
    }
    state = grant.state;
  }

  // `left` is unreachable in practice (a departed bot receives no events);
  // treated as closed-and-silent for the same reason `blocked` is.
  if (state === "blocked" || state === "left") {
    return {
      kind: "closed",
      outcome: { kind: "ignored", reason: "reach-blocked" },
    };
  }
  if (state === "pending") {
    return {
      kind: "closed",
      outcome: {
        kind: "refused",
        message: await pendingReachMessage({
          agentId: presence.agent.id,
          workspaceId: presence.agent.workspaceId,
        }),
      },
    };
  }
  return { kind: "open", state };
};

/**
 * Admit one guest message: verify the speaker is same-tenant (fail closed),
 * then create the turn with NO platform identity - `userId: null`, and a
 * framed prefix built from the cleaned display name. The "(guest)" framing
 * is OURS and unforgeable by the name because the name is cleaned, clamped,
 * and embedded inside our template - the same posture as the member prefix.
 * Attachments are accepted under the same caps as members (the user's
 * decision: whoever may speak, may speak fully).
 */
const admitGuest = async (
  presence: PresenceRow,
  input: GroupMessageInput,
): Promise<IngestOutcome> => {
  const providerId = presence.provider as ChannelProviderId;
  const reach = channelProvider(providerId).reach;
  if (!reach) return { kind: "ignored", reason: "no-reach-facet" };

  const credentialsJson = presence.credentials
    ? await getCrypto().decrypt(presence.credentials)
    : null;
  const guest = await reach.resolveGuestSpeaker({
    credentialsJson,
    externalUserId: input.externalUserId,
    tenantExternalId: presence.integration.externalId,
  });
  if (!guest) {
    return { kind: "ignored", reason: "guest-unverifiable" };
  }
  if (!guest.sameTenant) {
    // Slack Connect / foreign workspace: outside the v1 grant's scope.
    return { kind: "ignored", reason: "guest-foreign-tenant" };
  }

  const conversation = await ensureSourcedConversation(
    presence.agent.workspaceId,
    presence.agent.id,
    {
      source: providerId,
      externalRef: input.externalThreadId,
      ...(input.title && { title: input.title }),
    },
  );
  await upsertThreadLink({
    agentChannelId: presence.id,
    conversationId: conversation.id,
    externalThreadId: input.externalThreadId,
    kind: "group",
    externalUserId: null,
  });

  const speakerName = cleanName(guest.displayName ?? "someone");

  const attachmentIds = await ingestMessageFiles(
    presence,
    conversation.id,
    null,
    input.files ?? [],
  );

  return createTurnOutcome(
    presence,
    conversation.id,
    `${speakerName} (guest): ${input.text}`,
    null,
    attachmentIds,
  );
};

export interface GroupInviteInput {
  agentChannelId: string;
  inviterExternalUserId: string | null;
  /** The provider-opaque space just joined (Slack: the channel id) - the
   * reach grant's subject. Null on providers/paths that do not name it. */
  channel?: string | null;
  eventId: string;
}

export type GroupInviteOutcome =
  | { kind: "duplicate" }
  | { kind: "accept" }
  | { kind: "refuse"; leave: boolean; message: string };

/**
 * The agent was invited to a group surface. Slack cannot prevent the invite,
 * so the gate is the response: an inviter who does not map to a
 * workspace-authorized user gets a polite refusal and the adapter leaves.
 * An UNKNOWN inviter (Slack omits it on some paths) is refused — fail closed.
 */
export const ingestGroupInvite = async (
  input: GroupInviteInput,
): Promise<GroupInviteOutcome> => {
  const presence = await requirePresence(input.agentChannelId);

  if (!(await recordEventOnce(presence.id, input.eventId))) {
    return { kind: "duplicate" };
  }

  // `leave: false`, deliberately (docs-verified 2026-08-07): leaving a channel
  // needs `channels:manage`/`groups:write` — granting every agent bot the
  // power to manage channels just to exit one is the wrong trade. The bot
  // stays MUTED instead: unlinked-thread events are ignored by design, so
  // staying is inert, and the copy tells people how to remove it. The wire's
  // `leave` field stays for a provider whose exit costs nothing.
  const STAY_MUTED =
    " I'll stay muted in this channel. Anyone can remove me from it.";
  if (!input.inviterExternalUserId) {
    return {
      kind: "refuse",
      leave: false,
      message:
        refusalNotLinked(presence.provider as ChannelProviderId) + STAY_MUTED,
    };
  }

  const speaker = await authorizeSpeaker(presence, input.inviterExternalUserId);
  if ("refusal" in speaker) {
    return {
      kind: "refuse",
      leave: false,
      message: speaker.refusal + STAY_MUTED,
    };
  }

  // The invite hook: an ACCEPTED invite plants the pending space grant and
  // posts the owner-DM reach cards ("may I answer everyone here?") - the
  // knock the whole feature exists for. Detached and failure-tolerant: the
  // accept must never be delayed or broken by the card path (the lazy
  // re-offer in the message door and the sweep both re-cover it).
  if (input.channel) {
    const providerId = presence.provider as ChannelProviderId;
    const reach = channelProvider(providerId).reach;
    if (reach) {
      void (async () => {
        const { ensureSpaceGrant, postReachCards } =
          await import("./agent-reach-service");
        const credentialsJson = presence.credentials
          ? await getCrypto().decrypt(presence.credentials)
          : null;
        const label = await reach
          .spaceLabel({ credentialsJson, externalRef: input.channel ?? "" })
          .catch(() => null);
        const grant = await ensureSpaceGrant({
          agentId: presence.agent.id,
          integrationId: presence.integrationId,
          provider: providerId,
          externalRef: input.channel ?? "",
          subjectLabel: label,
        });
        if (grant.created) await postReachCards(grant.id);
      })().catch((err: unknown) =>
        log.warn({ err, presenceId: presence.id }, "invite reach hook failed"),
      );
    }
  }

  return { kind: "accept" };
};

export interface GroupLeaveInput {
  agentChannelId: string;
  /** The provider-opaque space the bot was removed from (Slack: channel id). */
  channel: string;
  eventId: string;
}

/**
 * The bot was REMOVED from a group surface - the invite's mirror. Cleanup,
 * not authorization: whoever removed it acted with the provider's own
 * permission model, so there is no speaker to authorize and nothing to
 * refuse. Deletes the channel's thread links (the routing rows a dead
 * membership can never serve - a re-mention after a re-invite re-creates
 * them and resumes the same conversations), parks any reach grant as
 * `left` (a re-invite re-knocks; the decision history stays on the row),
 * and settles open owner cards so a pending question about a channel the
 * agent just left does not dangle.
 */
export const ingestGroupLeave = async (
  input: GroupLeaveInput,
): Promise<void> => {
  const presence = await requirePresence(input.agentChannelId);
  if (!(await recordEventOnce(presence.id, input.eventId))) return;

  // Thread links for THIS channel: the group-thread address is provider-
  // minted as `<channel>:<threadTs>` - match by the provider's own space
  // key so the generic door never parses the format itself.
  const reach = channelProvider(presence.provider as ChannelProviderId).reach;
  const links = await db.channelThreadLink.findMany({
    where: { agentChannelId: presence.id, kind: "group" },
    select: { id: true, externalThreadId: true },
  });
  const doomed = links.filter(
    (link) => reach && reach.spaceOf(link.externalThreadId) === input.channel,
  );
  if (doomed.length > 0) {
    await db.channelThreadLink.deleteMany({
      where: { id: { in: doomed.map((l) => l.id) } },
    });
  }

  const { parkGrantOnLeave } = await import("./agent-reach-service");
  await parkGrantOnLeave({
    agentId: presence.agent.id,
    integrationId: presence.integrationId,
    provider: presence.provider as ChannelProviderId,
    externalRef: input.channel,
  }).catch((err: unknown) =>
    log.warn({ err, presenceId: presence.id }, "leave grant park failed"),
  );
};
