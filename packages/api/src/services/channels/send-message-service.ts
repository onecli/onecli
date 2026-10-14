import { db, Prisma } from "@onecli/db";
import { mentionNamesOf, normalizeMentionName } from "@onecli/channels";
import { getCrypto } from "../../providers";
import { ServiceError } from "../errors";
import {
  registerActionHandler,
  requestActionApproval,
} from "./action-approval-service";
import { resolveMentionNames } from "./mention-resolution-service";
import { findChannels } from "./recipient-search-service";
import { noteOutboundFailure } from "./agent-channel-service";
import { authorizeChannelUser } from "./channel-ingestion-service";
import { channelProvider, isChannelProviderId } from "./registry";
import { logger } from "../../lib/logger";
import { cleanLabel } from "../../lib/format";
import { previousRunStartedAt } from "../turn-service";
import { decideReachGrant, ensurePersonGrant } from "./agent-reach-service";

const log = logger.child({ component: "send-message" });

/**
 * send_message — the OUTBOUND capability (roadmap 4c): the agent proactively
 * messages a person or channel, gated by the address book.
 *
 * The division of labor, deliberately nothing new:
 *  - WHO: `resolveMentionNames` (anchors → linked directory) for people and
 *    `findChannels` for channels — the same resolution the mention renderer
 *    trusts, id-bound at resolve time so a rename between resolve and send
 *    changes nothing;
 *  - WHETHER: the contact row (`agent_contacts`) — `allow` sends now, `ask`
 *    (or no row, the default) holds a one-shot `action_approvals` row and
 *    the owner decides on the 4b card;
 *  - HOW: the payload frozen at hold time is executed verbatim by the
 *    registered handler (4b's row-is-truth contract) through the same
 *    renderer the mirror uses (`markdownToMrkdwn`) and the events arm's
 *    `postMessage`.
 *
 * The summary the owner reads carries the recipient LABEL and the full text
 * (clamped by the approval service) — an owner approves what will actually
 * be sent, never a paraphrase.
 */

/** The action key in 4b's registry — the wire-stable handler name. */
export const SEND_MESSAGE_ACTION = "channel.send_message";

/** Outbound message cap — matches the model-facing arg schema's bound. */
const MAX_SEND_TEXT_CHARS = 4000;

export interface SendRecipient {
  /** "app" (4e) = another Slack app's bot user: DM-able through the same
   * gate as a person, invoke-only (its replies never come back — 5a). */
  kind: "person" | "channel" | "app";
  /** Provider-opaque id (Slack: U…/W… or C…) — frozen at resolve time. */
  ref: string;
  /** Display label for summaries and dashboards — never matched on. */
  label: string;
}

/** The frozen payload shape (4b's row-is-truth: written once at hold). */
interface SendPayload {
  to: SendRecipient;
  text: string;
  /** BODY mentions, resolved at request time and frozen with the text:
   * normalized name → provider id. The owner's card approves exactly what
   * will post — a rename or block between hold and approve changes the
   * rendered pings nothing (the renderer re-reads nothing). Absent on
   * pre-extension rows: their tokens degrade to plain text, the old
   * behavior. */
  mentions?: Record<string, string>;
}

/** Validate-then-narrow (never cast-first): the frozen row is the only
 * JSON boundary, and a malformed row must fail the approval loudly. */
const payloadOf = (raw: Prisma.JsonValue): SendPayload => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("malformed send payload");
  }
  const to = (raw as Record<string, unknown>).to;
  const text = (raw as Record<string, unknown>).text;
  if (to === null || typeof to !== "object" || typeof text !== "string") {
    throw new Error("malformed send payload");
  }
  const kind = (to as Record<string, unknown>).kind;
  const ref = (to as Record<string, unknown>).ref;
  const label = (to as Record<string, unknown>).label;
  if (
    (kind !== "person" && kind !== "channel" && kind !== "app") ||
    typeof ref !== "string" ||
    typeof label !== "string"
  ) {
    throw new Error("malformed send payload");
  }
  const mentions = (raw as Record<string, unknown>).mentions;
  let frozenMentions: Record<string, string> | undefined;
  if (mentions !== undefined) {
    if (
      mentions === null ||
      typeof mentions !== "object" ||
      Array.isArray(mentions)
    ) {
      throw new Error("malformed send payload");
    }
    frozenMentions = {};
    for (const [name, id] of Object.entries(
      mentions as Record<string, unknown>,
    )) {
      if (typeof id !== "string") throw new Error("malformed send payload");
      frozenMentions[name] = id;
    }
  }
  return {
    to: { kind, ref, label },
    text,
    ...(frozenMentions ? { mentions: frozenMentions } : {}),
  };
};

/**
 * Resolve a model-given recipient to an id-anchored target.
 *
 * People walk the mention contract exactly (anchors first, then the linked
 * directory, exact normalized match) — the same names the model was taught
 * to write. Channels go through the discovery search and accept only an
 * EXACT normalized name match ("#guy-private" → the one channel of that
 * name); fuzzy picking is find_recipient's job, where the AGENT chooses.
 */
const resolveSendRecipient = async (
  agentId: string,
  to: string,
  originConversationId: string | null,
): Promise<SendRecipient> => {
  // Accept the shapes the model is taught elsewhere: a bare name, the
  // mention grammar (@[Name]), or a leading @ — all normalize to the name.
  const raw = to
    .trim()
    .replace(/^@\[(.+)\]$/, "$1")
    .replace(/^@(?!\[)/, "")
    .trim();
  if (!raw) throw new ServiceError("UNPROCESSABLE", "Recipient is required");

  if (raw.startsWith("#")) {
    const wanted = normalizeMentionName(raw.replace(/^#/, ""));
    const candidates = await findChannels(agentId, raw);
    const exact = candidates.find(
      (c) => normalizeMentionName(c.name.replace(/^#/, "")) === wanted,
    );
    if (!exact) {
      throw new ServiceError(
        "UNPROCESSABLE",
        `No channel named "${raw}" is visible to this agent. Use find_recipient to search.`,
      );
    }
    return { kind: "channel", ref: exact.ref, label: exact.name };
  }

  const presence = await db.agentChannel.findFirst({
    where: { agentId, status: "active" },
    select: { id: true },
  });
  if (!presence) {
    throw new ServiceError(
      "UNPROCESSABLE",
      "This agent has no active channel presence to send from.",
    );
  }
  // The conversation's anchor for this name, read ONCE: it carries the
  // pick-time kind (person vs app) for a resolvable name, and the honest
  // blocked reason for an unresolvable one.
  const anchored = originConversationId
    ? await db.mentionAnchor.findUnique({
        where: {
          conversationId_name: {
            conversationId: originConversationId,
            name: normalizeMentionName(raw),
          },
        },
        select: { externalUserId: true, displayName: true, kind: true },
      })
    : null;
  const [resolution] = await resolveMentionNames(
    presence.id,
    [raw],
    originConversationId ?? undefined,
  );
  if (!resolution || resolution.kind === "unknown") {
    // A blocked contact degrades resolution to unknown (the no-ping rule) —
    // but the SEND path owes the model the honest reason, not a "try
    // find_recipient" that cannot help. The anchor still knows the ref.
    if (anchored) {
      const blocked = await db.agentContact.findFirst({
        where: {
          agentId,
          externalRef: anchored.externalUserId,
          policy: "blocked",
        },
        select: { id: true },
      });
      if (blocked) {
        throw new ServiceError(
          "UNPROCESSABLE",
          `The workspace owner has blocked messaging ${anchored.displayName}. Don't retry.`,
        );
      }
    }
    throw new ServiceError(
      "UNPROCESSABLE",
      `"${raw}" doesn't match anyone you can message. Use find_recipient to get the exact name first.`,
    );
  }
  if (resolution.kind === "ambiguous") {
    throw new ServiceError(
      "UNPROCESSABLE",
      `"${raw}" matches more than one person (${resolution.candidates.join(
        ", ",
      )}). Use find_recipient to pick one.`,
    );
  }
  // The anchor's pick-time kind decides person vs app: a directory match
  // (linked teammate) is person by construction — bots have no links — so
  // only an anchored pick can name an app. The ref must match too: a
  // coincidental same-name anchor for a different id says nothing.
  const isApp =
    anchored?.kind === "app" &&
    anchored.externalUserId === resolution.externalUserId;
  return {
    kind: isApp ? "app" : "person",
    ref: resolution.externalUserId,
    label: resolution.displayName,
  };
};

/** The contact policy for one recipient, and who set it. No row means
 * `ask` (the default: every send to an undecided recipient holds for the
 * owner). `blocked` (4e) is the owner's standing NO: refused before any
 * card. */
const policyOf = async (
  agentId: string,
  recipient: SendRecipient,
): Promise<{
  policy: "ask" | "allow" | "blocked";
  decidedByUserId: string | null;
}> => {
  const contact = await db.agentContact.findUnique({
    where: {
      agentId_kind_externalRef: {
        agentId,
        kind: recipient.kind,
        externalRef: recipient.ref,
      },
    },
    select: { policy: true, decidedByUserId: true },
  });
  if (contact?.policy === "allow" || contact?.policy === "blocked") {
    return { policy: contact.policy, decidedByUserId: contact.decidedByUserId };
  }
  return { policy: "ask", decidedByUserId: null };
};

/**
 * Upsert the contact to `allow` — the "Approve + always allow" flip and the
 * dashboard's policy PUT both land here. The label refreshes on upsert (a
 * later decision saw a later name); the id key never changes.
 */
export const allowContact = async (input: {
  agentId: string;
  recipient: SendRecipient;
  deciderUserId: string | null;
}): Promise<void> => {
  // A BLOCKED row is sticky (policies only tighten): a stale card's
  // "always allow" click must never silently undo an explicit block — the
  // dashboard's deliberate Unblock is the only way out. Without this, the
  // hook (which runs before execute) would flip blocked→allow and defeat
  // the execute-time block re-check.
  const flipped = await db.agentContact.updateMany({
    where: {
      agentId: input.agentId,
      kind: input.recipient.kind,
      externalRef: input.recipient.ref,
      policy: { not: "blocked" },
    },
    data: {
      policy: "allow",
      displayName: input.recipient.label,
      decidedByUserId: input.deciderUserId,
    },
  });
  if (flipped.count > 0) return;
  // No row yet (create), or a blocked row (leave untouched).
  await db.agentContact
    .create({
      data: {
        agentId: input.agentId,
        kind: input.recipient.kind,
        externalRef: input.recipient.ref,
        displayName: input.recipient.label,
        policy: "allow",
        decidedByUserId: input.deciderUserId,
      },
    })
    .catch((err: unknown) => {
      // P2002 = the row exists (necessarily blocked, per the updateMany
      // above) — exactly the leave-untouched case.
      if (
        !(
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        )
      ) {
        throw err;
      }
    });
};

/**
 * Who stands behind a delivered send, for its follow-on grants and records:
 *  - `deciderUserId`: the person who approved it, or who set the standing
 *    `allow` it went out under. Null when nobody decided (the manager
 *    shortcut, or an `allow` row with no recorded decider): then nothing
 *    is opened in anyone's name.
 *  - `toManager`: the recipient is the agent's manager (computed once per
 *    send by the caller, never re-asked mid-send).
 *  - `originConversationId` / `originTurnId`: where the send was asked from,
 *    so a reply can later be framed with what was asked and for whom.
 */
interface SendAuthority {
  deciderUserId: string | null;
  toManager: boolean;
  originConversationId: string | null;
  originTurnId: string | null;
}

/**
 * Execute one frozen send — the registered 4b handler. Bounded-fast (one
 * render + one or two Slack calls), per the handler contract. Throws into
 * the approval service's failure arm on any miss: the owner's card then
 * reads "approved, but it failed — the agent was told", which is the honest
 * outcome for a revoked credential or a deleted channel.
 */
const executeSend = async (
  agentId: string,
  payload: SendPayload,
  authority: SendAuthority,
): Promise<void> => {
  // Approve-time re-check (the 4a verifySubject lesson): a hold created
  // BEFORE the owner blocked this recipient still has a live card, and an
  // approve after the block must not deliver. Fail closed with the honest
  // reason — the approval settles `failed` and the agent hears why.
  const nowBlocked = await db.agentContact.findFirst({
    where: {
      agentId,
      kind: payload.to.kind,
      externalRef: payload.to.ref,
      policy: "blocked",
    },
    select: { id: true },
  });
  if (nowBlocked) {
    throw new Error(
      `the workspace owner has blocked messaging ${payload.to.label}`,
    );
  }
  const presence = await db.agentChannel.findFirst({
    where: { agentId, status: "active" },
    select: {
      id: true,
      provider: true,
      credentials: true,
      integrationId: true,
    },
  });
  if (!presence?.credentials) {
    throw new Error("no active channel presence to send from");
  }
  // The column is a free string; a row from a build that knew a provider
  // this one does not has nothing to send through.
  if (!isChannelProviderId(presence.provider)) {
    throw new Error(`unknown channel provider "${presence.provider}"`);
  }
  const provider = channelProvider(presence.provider);
  const credentialsJson = await getCrypto().decrypt(presence.credentials);
  const intro = authority.toManager
    ? null
    : await firstContactIntro(agentId, presence.id, payload.to);

  let delivered: { externalThreadId: string };
  try {
    // The provider addresses the recipient and renders the text natively,
    // with the mention map FROZEN at request time: body @[Name] tokens ping
    // exactly who was resolved when the owner read the card — never
    // re-resolved at execute (rename-proof, the anchor philosophy).
    delivered = await provider.sendMessage({
      credentialsJson,
      to: { kind: payload.to.kind, ref: payload.to.ref },
      text: intro ? `${intro}\n\n${payload.text}` : payload.text,
      ...(payload.mentions && {
        mentions: new Map(Object.entries(payload.mentions)),
      }),
    });
  } catch (err) {
    // A refusal that means the app itself is gone (deleted on the provider's
    // side, a missed uninstall webhook) flips the presence here — the
    // outbound half of removal detection — and the agent hears why.
    if (await noteOutboundFailure(presence.id, err)) {
      const platform = provider.displayName;
      throw new ServiceError(
        "UNPROCESSABLE",
        `Your ${platform} app was removed from the workspace, so this message could not be sent. It needs to be re-attached from your Channels page before you can reach ${platform} again.`,
      );
    }
    throw err;
  }

  // Best-effort, after delivery: never fails the send.
  await recordSentMessage({
    agentChannelId: presence.id,
    externalThreadId: delivered.externalThreadId,
    recipientLabel: payload.to.label,
    text: payload.text,
    originConversationId: authority.originConversationId,
    originTurnId: authority.originTurnId,
  }).catch((err: unknown) =>
    log.warn({ agentId, err: String(err) }, "recording the send failed"),
  );
  // Delivered: the recipient now belongs in the agent's address book, so
  // the owner can see who it has reached and set a standing policy without
  // waiting for the next card. Never the manager: that send skipped the
  // gate, and an `ask` row would say the next one asks. Best-effort: the
  // message is already out.
  if (!authority.toManager) {
    await recordContact(agentId, payload.to).catch((err: unknown) =>
      log.warn(
        { agentId, err: String(err) },
        "delivered, but the contact row was not recorded",
      ),
    );
  }
  if (
    payload.to.kind === "person" &&
    !authority.toManager &&
    authority.deciderUserId
  ) {
    await openRepliesFrom({
      agentId,
      provider: presence.provider,
      integrationId: presence.integrationId,
      to: payload.to,
      deciderUserId: authority.deciderUserId,
    }).catch((err: unknown) =>
      log.warn({ agentId, err: String(err) }, "opening replies failed"),
    );
  }
};

/**
 * Make sure a recipient the agent DELIVERED to has a contact row. A new row
 * is `ask`, which is exactly the no-row default (every send still asks),
 * so this changes visibility, never permission. An existing row keeps its
 * policy untouched and only refreshes the display name.
 */
const recordContact = async (
  agentId: string,
  to: SendRecipient,
): Promise<void> => {
  await db.agentContact.upsert({
    where: {
      agentId_kind_externalRef: {
        agentId,
        kind: to.kind,
        externalRef: to.ref,
      },
    },
    create: {
      agentId,
      kind: to.kind,
      externalRef: to.ref,
      displayName: to.label,
      policy: "ask",
    },
    update: { displayName: to.label },
  });
};

/**
 * A person the agent was sent to message can answer it. Without this the
 * owner approves the send, the person replies, and the reply hits a
 * second "approve this person?" gate. Delivering to them was a decision,
 * so their reply lane opens in the name of whoever made it (the approver,
 * or whoever set the standing `allow`), through `decideReachGrant`, so the
 * audit, the tenant recheck and the card rewrite all run. Narrow: only an
 * unsettled question (no row, pending, expired) is answered; an explicit
 * block or members-only is never overridden.
 */
const openRepliesFrom = async (input: {
  agentId: string;
  provider: string;
  integrationId: string;
  to: SendRecipient;
  deciderUserId: string;
}): Promise<void> => {
  if (!isChannelProviderId(input.provider)) return;
  if (!channelProvider(input.provider).reach) return;
  const grant = await ensurePersonGrant({
    agentId: input.agentId,
    integrationId: input.integrationId,
    provider: input.provider,
    externalRef: input.to.ref,
    subjectLabel: input.to.label,
  });
  if (grant.state !== "pending") return;
  await decideReachGrant({
    grantId: grant.id,
    decision: "approved",
    deciderUserId: input.deciderUserId,
  });
};

/**
 * The platform's one-line introduction on an agent's FIRST message to a
 * person: who is writing and on whose behalf, so a DM from a bot nobody
 * has met is not a mystery. Platform-authored and fixed (the agent cannot
 * word it). Only while this person has no history with the agent: no
 * earlier executed send, no contact row, no DM thread (a linked teammate
 * who already chats with it), and no reach row (a person who already
 * knocked). Names only: the manager's email never rides into a DM to
 * someone outside the workspace.
 */
const firstContactIntro = async (
  agentId: string,
  presenceId: string,
  to: SendRecipient,
): Promise<string | null> => {
  if (to.kind !== "person") return null;
  const [contact, thread, knocked, earlier, agent] = await Promise.all([
    db.agentContact.findFirst({
      where: { agentId, kind: to.kind, externalRef: to.ref },
      select: { id: true },
    }),
    db.channelThreadLink.findFirst({
      where: {
        agentChannelId: presenceId,
        kind: "direct",
        externalUserId: to.ref,
      },
      select: { id: true },
    }),
    db.agentReachGrant.findFirst({
      where: { agentId, subjectKind: "external_user", externalRef: to.ref },
      select: { id: true },
    }),
    db.actionApproval.findFirst({
      where: {
        agentId,
        action: SEND_MESSAGE_ACTION,
        status: "executed",
        AND: [
          { payload: { path: ["to", "kind"], equals: to.kind } },
          { payload: { path: ["to", "ref"], equals: to.ref } },
        ],
      },
      select: { id: true },
    }),
    db.agent.findUnique({
      where: { id: agentId },
      select: {
        name: true,
        channels: {
          where: { id: presenceId },
          select: { createdBy: { select: { name: true } } },
        },
      },
    }),
  ]);
  if (contact || thread || knocked || earlier || !agent) return null;
  const managerName = agent.channels[0]?.createdBy?.name?.trim();
  const name = cleanLabel(agent.name, 80);
  return managerName
    ? `_Hi, I'm ${name}, an AI agent working for ${cleanLabel(managerName, 80)}. You can reply right here._`
    : `_Hi, I'm ${name}, an AI agent. You can reply right here._`;
};

/** Module-load registration — the 4c consumer the 4b registry was built
 * for. One action, one handler, plus the always-allow hook: the card's
 * third button flips the frozen recipient's contact to `allow` (read from
 * the row, never re-resolved — the owner approved THIS recipient). */
registerActionHandler(
  SEND_MESSAGE_ACTION,
  async (approval) => {
    // The one place the frozen JSON re-enters typed land — validated, so a
    // malformed row fails the approval loudly instead of posting garbage.
    const payload = payloadOf(approval.payload);
    await executeSend(approval.agentId, payload, {
      deciderUserId: approval.decidedByUserId,
      toManager:
        payload.to.kind === "person" &&
        (await isPresenceManager(approval.agentId, payload.to.ref)),
      originConversationId: approval.conversationId,
      originTurnId: approval.originTurnId,
    });
  },
  {
    alwaysAllow: async (approval, deciderUserId) => {
      await allowContact({
        agentId: approval.agentId,
        recipient: sendRecipientOfPayload(approval.payload),
        deciderUserId,
      });
    },
  },
);

export type SendOutcome =
  | { kind: "sent"; to: string }
  | { kind: "held"; to: string; approvalId: string }
  /** An earlier ask to this recipient is still undecided: THIS message was
   * not sent and no new card went out. One open ask per recipient keeps
   * the owner from approving two sends to one person. */
  | { kind: "busy"; to: string; approvalId: string };

/**
 * Is this provider user the agent's manager: the member who attached the
 * active presence, linked to this Slack identity, and still able to reach
 * the agent's workspace? Every hop is a fresh read, so a revoked link, a
 * suspended membership or a lost workspace grant ends the shortcut.
 */
const isPresenceManager = async (
  agentId: string,
  externalUserId: string,
): Promise<boolean> => {
  const presence = await db.agentChannel.findFirst({
    where: { agentId, status: "active" },
    select: {
      integrationId: true,
      createdByUserId: true,
      integration: { select: { organizationId: true } },
      agent: {
        select: {
          workspace: { select: { id: true, organizationId: true } },
        },
      },
    },
  });
  if (!presence?.createdByUserId) return false;
  const link = await db.channelUserLink.findUnique({
    where: {
      integrationId_externalUserId: {
        integrationId: presence.integrationId,
        externalUserId,
      },
    },
    select: { userId: true },
  });
  if (link?.userId !== presence.createdByUserId) return false;
  const authorized = await authorizeChannelUser(
    presence.integrationId,
    presence.integration.organizationId,
    presence.agent.workspace,
    externalUserId,
  );
  return authorized?.userId === presence.createdByUserId;
};

/**
 * The tool door: resolve → guard → send or hold. The origin conversation
 * (provenance-verified by the caller) anchors the approval's outcome notice
 * so the model hears the decision on its own turn.
 */
export const requestSend = async (input: {
  agentId: string;
  to: string;
  text: string;
  originConversationId: string | null;
  originTurnId: string | null;
}): Promise<SendOutcome> => {
  const text = input.text.trim();
  if (!text)
    throw new ServiceError("UNPROCESSABLE", "Message text is required");
  if (text.length > MAX_SEND_TEXT_CHARS) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `Message too long (max ${MAX_SEND_TEXT_CHARS} characters)`,
    );
  }

  const recipient = await resolveSendRecipient(
    input.agentId,
    input.to,
    input.originConversationId,
  );
  // Slack's own platform rule: a bot cannot DM another bot
  // (conversations.open → cannot_dm_bot, no scope changes it). Refuse at
  // REQUEST time with the workable alternative — never hold an approval
  // the owner can only approve into a failure.
  if (recipient.kind === "app") {
    throw new ServiceError(
      "UNPROCESSABLE",
      `${recipient.label} is a Slack app, and Slack does not allow DMs between apps. Mention @[${recipient.label}] in a shared channel instead - that invokes it.`,
    );
  }

  // BODY mentions, resolved NOW and frozen into the payload: the mirror's
  // own resolve walk (anchors → directory, blocked refs already degraded
  // to unknown inside it), so a channel send can carry working pings —
  // including of apps ("mention it in a channel" must work proactively
  // too). Unresolved tokens stay out of the map and post as plain text.
  let mentions: Record<string, string> | undefined;
  const bodyNames = mentionNamesOf(text);
  if (bodyNames.length > 0) {
    const presence = await db.agentChannel.findFirst({
      where: { agentId: input.agentId, status: "active" },
      select: { id: true },
    });
    if (presence) {
      const resolutions = await resolveMentionNames(
        presence.id,
        bodyNames,
        input.originConversationId ?? undefined,
      );
      const map: Record<string, string> = {};
      for (const resolution of resolutions) {
        if (resolution.kind === "resolved") {
          map[resolution.name] = resolution.externalUserId;
        }
      }
      // The map rides even when EMPTY: with a map, unresolved tokens
      // degrade to visible @Name (the mirror's exact rule); without one
      // they post as raw @[Name] grammar — never show the wire syntax.
      mentions = map;
    }
  }
  const payload: SendPayload = {
    to: recipient,
    text,
    ...(mentions ? { mentions } : {}),
  };

  const { policy, decidedByUserId } = await policyOf(input.agentId, recipient);
  if (policy === "blocked") {
    // The owner's standing no — terminal for the model, with the reason.
    throw new ServiceError(
      "UNPROCESSABLE",
      `The workspace owner has blocked messaging ${recipient.label}. Don't retry.`,
    );
  }
  // The agent's MANAGER (the member who attached this presence and decides
  // its asks) never needs to approve a message to themselves: asking "may
  // I tell you their answer?" is noise, and that relay is the whole point
  // of the errand. Narrow on purpose: the presence's creator only, a
  // person (never a channel), and only while they still hold the workspace
  // (a departed manager is just another recipient). Checked once per send.
  const toManager =
    recipient.kind === "person" &&
    (await isPresenceManager(input.agentId, recipient.ref));
  if (policy === "allow" || toManager) {
    await executeSend(input.agentId, payload, {
      // Nobody decided THIS send to the manager; an `allow` send stands on
      // whoever set the standing allow.
      deciderUserId: toManager ? null : decidedByUserId,
      toManager,
      originConversationId: input.originConversationId,
      originTurnId: input.originTurnId,
    });
    log.info(
      { agentId: input.agentId, kind: recipient.kind },
      toManager
        ? "send_message delivered (to the agent's manager)"
        : "send_message delivered (allow contact)",
    );
    return { kind: "sent", to: recipient.label };
  }

  // ONE open ask per recipient. A second send to someone whose first send
  // still waits would put two cards in the owner's DM, and approving both
  // delivers twice. This message is NOT sent and NOT queued; the model is
  // told so, and may send it once the first ask is decided.
  const waiting = await db.actionApproval.findFirst({
    where: {
      agentId: input.agentId,
      action: SEND_MESSAGE_ACTION,
      status: "pending",
      expiresAt: { gt: new Date() },
      AND: [
        { payload: { path: ["to", "kind"], equals: recipient.kind } },
        { payload: { path: ["to", "ref"], equals: recipient.ref } },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (waiting) {
    return { kind: "busy", to: recipient.label, approvalId: waiting.id };
  }

  const held = await requestActionApproval({
    agentId: input.agentId,
    conversationId: input.originConversationId,
    originTurnId: input.originTurnId,
    action: SEND_MESSAGE_ACTION,
    // Structurally JSON (two strings + a literal union) — the cast only
    // bridges TS's nominal InputJsonValue, it never hides a Date or class.
    payload: payload as unknown as Prisma.InputJsonValue,
    // No app arm: an app recipient was refused above (cannot_dm_bot) —
    // only people and channels ever reach a hold.
    summary: `send ${recipient.kind === "channel" ? recipient.label : `@${recipient.label}`}: "${text}"`,
  });
  return { kind: "held", to: recipient.label, approvalId: held.id };
};

/** The frozen payload's recipient — what the approve_always flip upserts.
 * Read from the row, never re-resolved: the owner approved THIS recipient. */
const sendRecipientOfPayload = (raw: Prisma.JsonValue): SendRecipient =>
  payloadOf(raw).to;

// ── The reply side: "you messaged this person for someone" ─────────────────

/** How long a delivered send can still frame a reply (the ledger's
 * retention too: an older row can never be shown, so it is pruned), how
 * many one note shows, and how much of each text. */
const SENT_CONTEXT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const SENT_CONTEXT_MAX = 3;
const SENT_CONTEXT_TEXT_CHARS = 500;

/**
 * Record one delivered send in the ledger (`channel_sent_messages`): where a
 * reply will arrive, what was sent there, and from which conversation (and
 * whose turn). Called after every delivery, whichever door it went through.
 * The person is kept as a user reference, so a deleted account takes its
 * name with it. Opportunistically prunes this presence's rows past the
 * window, so the table stays a working set.
 */
const recordSentMessage = async (input: {
  agentChannelId: string;
  externalThreadId: string;
  recipientLabel: string;
  text: string;
  originConversationId: string | null;
  originTurnId: string | null;
}): Promise<void> => {
  const originTurn =
    input.originTurnId && input.originConversationId
      ? await db.turn.findFirst({
          // Fenced to its own conversation: the pair was provenance-checked
          // at the tool door, and a mismatched pair attributes nobody.
          where: {
            id: input.originTurnId,
            conversationId: input.originConversationId,
          },
          select: { userId: true },
        })
      : null;
  await db.channelSentMessage.create({
    data: {
      agentChannelId: input.agentChannelId,
      externalThreadId: input.externalThreadId,
      recipientLabel: input.recipientLabel,
      text: input.text,
      originConversationId: input.originConversationId,
      originUserId: originTurn?.userId ?? null,
    },
    select: { id: true },
  });
  // Fire-and-forget prune: losing one pass costs nothing.
  db.channelSentMessage
    .deleteMany({
      where: {
        agentChannelId: input.agentChannelId,
        createdAt: { lt: new Date(Date.now() - SENT_CONTEXT_WINDOW_MS) },
      },
    })
    .catch((err: unknown) =>
      log.warn(
        { agentChannelId: input.agentChannelId, err: String(err) },
        "sent-message prune failed",
      ),
    );
};

/**
 * The turn-start note in a conversation the agent DELIVERED a send into:
 * what it sent this person and from which conversation, so a reply is read
 * as the answer it is and passed back. Without it the reply opened a
 * conversation with no trace of the question, the agent asked the person
 * what they meant, and whoever wanted the answer never heard back.
 *
 * Scope, deliberately tight:
 *  - only sends whose reply address is THIS conversation's thread link,
 *    on the same presence, so another person's DM (or another agent's app
 *    in the same Slack workspace) never hears about it;
 *  - only those delivered since the model last ran here (news for one run,
 *    `previousRunStartedAt`), within the 3-day window, the newest 3;
 *  - never a send asked from this very conversation (a reply to it lands
 *    there anyway);
 *  - carries only words the recipient already received plus the display
 *    NAME of the person whose turn led to it. Never an email, which could
 *    otherwise reach a person outside the workspace; with no signed-in
 *    person (a guest, an automation run) it says only "another
 *    conversation".
 *
 * Delivery-only context, composed at dispatch, never stored; the caller
 * isolates failure.
 */
export const buildSentContext = async (
  conversationId: string,
  before: Date,
): Promise<string | null> => {
  const link = await db.channelThreadLink.findUnique({
    where: { conversationId },
    select: { agentChannelId: true, externalThreadId: true },
  });
  if (!link) return null;

  const lastRun = await previousRunStartedAt(conversationId, before);
  const windowStart = before.getTime() - SENT_CONTEXT_WINDOW_MS;
  const since = new Date(Math.max(windowStart, lastRun?.getTime() ?? 0));

  const sent = await db.channelSentMessage.findMany({
    where: {
      agentChannelId: link.agentChannelId,
      externalThreadId: link.externalThreadId,
      // Sent before this message was: a message cannot answer something
      // sent after it.
      createdAt: { gt: since, lte: before },
      // `not` alone would also drop rows with no origin.
      OR: [
        { originConversationId: null },
        { originConversationId: { not: conversationId } },
      ],
    },
    // The newest few (most likely what is being answered), shown oldest
    // first below.
    orderBy: { createdAt: "desc" },
    take: SENT_CONTEXT_MAX,
    select: {
      recipientLabel: true,
      text: true,
      originUser: { select: { name: true } },
    },
  });
  if (sent.length === 0) return null;

  const lines = sent.reverse().map((row) => {
    const person = cleanLabel(row.originUser?.name ?? "");
    const origin = person
      ? `a conversation with ${person}`
      : "another conversation";
    return `- From ${origin}, you sent ${cleanLabel(row.recipientLabel)}: "${cleanLabel(row.text, SENT_CONTEXT_TEXT_CHARS)}"`;
  });
  return [
    "Messages you sent into this conversation from elsewhere (the person writing now may be answering one):",
    ...lines,
    "If this message answers one, thank them briefly, then pass the answer back with send_message to the person who wanted it. If it doesn't, carry on as usual. Don't ask the person here what they meant.",
  ].join("\n");
};

// ── The dashboard's contact surface (agent-channels routes) ────────────────

/** The agent's decided contacts — dashboard list. Workspace-fenced at the
 * query (the listActionApprovals idiom): a foreign workspace reads []. */
export const listContacts = async (input: {
  workspaceId: string;
  agentId: string;
}) =>
  db.agentContact.findMany({
    where: {
      agentId: input.agentId,
      agent: { workspaceId: input.workspaceId },
    },
    select: {
      id: true,
      kind: true,
      externalRef: true,
      displayName: true,
      policy: true,
      updatedAt: true,
    },
    orderBy: [{ policy: "asc" }, { displayName: "asc" }],
  });

/**
 * Flip one contact's policy (dashboard PUT). `ask` is the revoke direction —
 * the row stays (the label and audit trail survive), only the standing
 * permission goes. Workspace-fenced at the query, not-found-shaped.
 */
export const setContactPolicy = async (input: {
  workspaceId: string;
  agentId: string;
  contactId: string;
  policy: "ask" | "allow" | "blocked";
  deciderUserId: string;
}): Promise<{ id: string; policy: string } | null> => {
  const flipped = await db.agentContact.updateMany({
    where: {
      id: input.contactId,
      agentId: input.agentId,
      agent: { workspaceId: input.workspaceId },
    },
    data: { policy: input.policy, decidedByUserId: input.deciderUserId },
  });
  if (flipped.count === 0) return null;
  return { id: input.contactId, policy: input.policy };
};

/** Remove a contact row entirely (dashboard DELETE) — back to the pristine
 * default (`ask`, no history). Workspace-fenced like the flip. */
export const deleteContact = async (input: {
  workspaceId: string;
  agentId: string;
  contactId: string;
}): Promise<boolean> => {
  const removed = await db.agentContact.deleteMany({
    where: {
      id: input.contactId,
      agentId: input.agentId,
      agent: { workspaceId: input.workspaceId },
    },
  });
  return removed.count > 0;
};
