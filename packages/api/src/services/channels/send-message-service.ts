import { db, Prisma } from "@onecli/db";
import { z } from "zod";
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
import {
  decideReachGrant,
  ensurePersonGrant,
  ensureSpaceGrant,
  parseState,
  workspaceOwnerRefs,
  type ReachDecision,
} from "./agent-reach-service";

const log = logger.child({ component: "send-message" });

/**
 * send_message — the OUTBOUND capability (roadmap 4c): the agent proactively
 * messages a person or channel, gated by that recipient's one setting.
 *
 * The division of labor, deliberately nothing new:
 *  - WHO: `resolveMentionNames` (anchors → linked directory) for people and
 *    `findChannels` for channels — the same resolution the mention renderer
 *    trusts, id-bound at resolve time so a rename between resolve and send
 *    changes nothing;
 *  - WHETHER: the recipient's one setting (its reach row) - allowed sends
 *    now, Never refuses, and no answer yet holds a one-shot
 *    `action_approvals` row and the owner decides on the 4b card;
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

/** A send refused because the contact is blocked (Can talk with = Never),
 * raised in the asking person's own chat: "Let <Agent> message <Name>?"
 * Allow / Don't send. Decided by that person. */
export const CONTACT_BLOCKED_ACTION = "channel.contact_blocked_send";

/** Who asked for a personal card, frozen with it: the verified reader of
 * the asking turn, their Slack id where a DM card can reach them ("" when
 * not linked yet), and the agent's name for the card's words. */
export const personalAskSchema = z.object({
  readerUserId: z.string().min(1),
  readerExternalUserId: z.string().catch(""),
  agentName: z.string(),
});

/** The contact-blocked request's frozen payload: the exact DM, plus who
 * asked. */
export type ContactBlockedPayload = SendPayload &
  z.infer<typeof personalAskSchema> & { to: { kind: "person" } };

export const contactBlockedPayloadOf = (
  raw: Prisma.JsonValue,
): ContactBlockedPayload => {
  const send = payloadOf(raw);
  const ask = personalAskSchema.parse(raw);
  if (send.to.kind !== "person") {
    throw new Error("malformed contact-blocked payload");
  }
  return { ...send, ...ask, to: { ...send.to, kind: "person" } };
};

/** The card's words: server-built, never the agent's. */
export const contactBlockedSummary = (agentName: string, name: string) =>
  `Let ${cleanLabel(agentName, 80) || "the agent"} message ${name}?`;

/** The model's line when a block refuses a send and no card can be raised
 * (a shared conversation: nobody verified to ask). */
const BLOCKED_HINT = "You can change this in Contacts.";

/** Outbound message cap — matches the model-facing arg schema's bound. */
const MAX_SEND_TEXT_CHARS = 4000;

export interface SendRecipient {
  kind: "person" | "channel";
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
    (kind !== "person" && kind !== "channel") ||
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
export const resolveSendRecipient = async (
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
    // (A blocked person still resolves; the recipient policy check refuses
    // the DM with the honest reason.)
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
  // The anchor's pick-time kind tells an app from a person: a directory
  // match (linked teammate) is a person by construction (bots have no
  // links), so only an anchored pick can name an app. The ref must match
  // too: a coincidental same-name anchor for a different id says nothing.
  // Slack's own platform rule: a bot cannot DM another bot
  // (conversations.open -> cannot_dm_bot, no scope changes it). Refuse at
  // REQUEST time with the workable alternative, never hold an approval the
  // owner can only approve into a failure.
  if (
    anchored?.kind === "app" &&
    anchored.externalUserId === resolution.externalUserId
  ) {
    throw new ServiceError(
      "UNPROCESSABLE",
      `${resolution.displayName} is a Slack app, and Slack does not allow DMs between apps. Mention @[${resolution.displayName}] in a shared channel instead - that invokes it.`,
    );
  }
  return {
    kind: "person",
    ref: resolution.externalUserId,
    label: resolution.displayName,
  };
};

/**
 * A recipient's ONE setting, read for the agent's own messages: its reach
 * row (a person's also decides their DMs; a channel's also decides what the
 * agent answers there). Never wins across integrations (fail closed);
 * Always allow sends; no answer yet (no row, pending, or parked) asks.
 */
const recipientPolicyOf = async (
  agentId: string,
  recipient: SendRecipient,
): Promise<"ask" | "allow" | "blocked"> => {
  const grants = await db.agentReachGrant.findMany({
    where: {
      agentId,
      subjectKind: recipient.kind === "channel" ? "space" : "external_user",
      externalRef: recipient.ref,
    },
    select: { state: true },
  });
  const states = grants.map((g) => parseState(g.state));
  if (states.includes("blocked")) return "blocked";
  if (states.includes("approved")) return "allow";
  return "ask";
};

/**
 * Never refuses a message, except to a workspace owner: their setting is a
 * fixed Always allow, so a Never stored before that lock never stops them.
 */
const isRefused = (
  policy: "ask" | "allow" | "blocked",
  manager: ManagerKind | null,
): boolean => policy === "blocked" && manager !== "owner";

/**
 * Record the owner's standing answer about a recipient: its reach row on
 * the active presence, through `decideReachGrant` (audit, the approve-time
 * recheck, the owner-card rewrite). Always allow only answers an open
 * question (no row, pending, or parked): it never lifts a Never set since
 * the card went out, and never re-decides. Never is the standing no, and
 * narrows anything.
 */
const settleRecipient = async (input: {
  agentId: string;
  to: SendRecipient;
  decision: ReachDecision;
  deciderUserId: string;
}): Promise<void> => {
  const presence = await db.agentChannel.findFirst({
    where: { agentId: input.agentId, status: "active" },
    select: { provider: true, integrationId: true },
  });
  if (!presence || !isChannelProviderId(presence.provider)) return;
  if (!channelProvider(presence.provider).reach) return;
  const ensure =
    input.to.kind === "channel" ? ensureSpaceGrant : ensurePersonGrant;
  const grant = await ensure({
    agentId: input.agentId,
    integrationId: presence.integrationId,
    provider: presence.provider,
    externalRef: input.to.ref,
    subjectLabel: input.to.label,
  });
  await decideReachGrant({
    grantId: grant.id,
    decision: input.decision,
    deciderUserId: input.deciderUserId,
    force: input.decision === "blocked",
  });
};

/**
 * Who stands behind a delivered send:
 *  - `manager`: whether the recipient is the agent's manager, and which
 *    kind (computed once per send by the caller, never re-asked mid-send);
 *  - `originConversationId` / `originTurnId`: where the send was asked from,
 *    so a reply can later be framed with what was asked and for whom.
 */
interface SendAuthority {
  manager: ManagerKind | null;
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
  if (
    isRefused(await recipientPolicyOf(agentId, payload.to), authority.manager)
  ) {
    throw new Error(
      `the workspace owner has blocked messaging ${payload.to.label}`,
    );
  }
  const presence = await db.agentChannel.findFirst({
    where: { agentId, status: "active" },
    select: { id: true, provider: true, credentials: true },
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
  const intro = authority.manager
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
};

/**
 * The platform's one-line introduction on an agent's FIRST message to a
 * person: who is writing and on whose behalf, so a DM from a bot nobody
 * has met is not a mystery. Platform-authored and fixed (the agent cannot
 * word it). Only while this person has no history with the agent: no
 * earlier executed send, no DM thread (a linked teammate
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
  const [thread, knocked, earlier, agent] = await Promise.all([
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
  if (thread || knocked || earlier || !agent) return null;
  const managerName = agent.channels[0]?.createdBy?.name?.trim();
  const name = cleanLabel(agent.name, 80);
  return managerName
    ? `_Hi, I'm ${name}, an AI agent working for ${cleanLabel(managerName, 80)}. You can reply right here._`
    : `_Hi, I'm ${name}, an AI agent. You can reply right here._`;
};

/** Module-load registration: the 4c consumer the 4b registry was built
 * for. The card asks about the RECIPIENT (Always allow / Never), never
 * about one message: each answer becomes the frozen recipient's one setting
 * (read from the row, never re-resolved: the owner answered about THIS
 * recipient). */
registerActionHandler(
  SEND_MESSAGE_ACTION,
  async (approval) => {
    // The one place the frozen JSON re-enters typed land — validated, so a
    // malformed row fails the approval loudly instead of posting garbage.
    const payload = payloadOf(approval.payload);
    await executeSend(approval.agentId, payload, {
      manager:
        payload.to.kind === "person"
          ? await managerKindOf(approval.agentId, payload.to.ref)
          : null,
      originConversationId: approval.conversationId,
      originTurnId: approval.originTurnId,
    });
  },
  {
    standing: {
      allow: (approval, deciderUserId) =>
        settleRecipient({
          agentId: approval.agentId,
          to: payloadOf(approval.payload).to,
          decision: "approved",
          deciderUserId,
        }),
      never: (approval, deciderUserId) =>
        settleRecipient({
          agentId: approval.agentId,
          to: payloadOf(approval.payload).to,
          decision: "blocked",
          deciderUserId,
        }),
    },
  },
);

/**
 * The blocked contact's card. Allow sets the person's Contacts setting to
 * Always allow (the same audited reach door the Contacts control uses),
 * then sends; Don't send is the reject. Decided by the person who asked.
 */
registerActionHandler(
  CONTACT_BLOCKED_ACTION,
  async (approval) => {
    const payload = contactBlockedPayloadOf(approval.payload);
    await allowPerson({
      agentId: approval.agentId,
      to: payload.to,
      deciderUserId: approval.decidedByUserId,
    });
    await executeSend(
      approval.agentId,
      {
        to: payload.to,
        text: payload.text,
        ...(payload.mentions && { mentions: payload.mentions }),
      },
      {
        manager: await managerKindOf(approval.agentId, payload.to.ref),
        originConversationId: approval.conversationId,
        originTurnId: approval.originTurnId,
      },
    );
    const agent = cleanLabel(payload.agentName, 80) || "the agent";
    return {
      note: `Sent as ${agent} to ${payload.to.label}: "${cleanLabel(payload.text, 200)}"`,
      resume: `Sent as ${agent} to ${payload.to.label}: "${cleanLabel(payload.text, 200)}". Already delivered: don't send it again. Confirm in one short line and continue the original request.`,
    };
  },
  {
    decidedBy: (payload) => {
      try {
        const p = contactBlockedPayloadOf(payload);
        return {
          userId: p.readerUserId,
          externalUserId: p.readerExternalUserId,
        };
      } catch {
        return null;
      }
    },
    // Allow / Don't send: one option, so the Slack card reads like the web.
    choices: () => [{ value: "allow", label: "Allow" }],
    resumeOnExecute: true,
    noteIsOutcome: true,
    // One live card per person asking and recipient: a fresher ask (or a
    // decision) replaces the older ones.
    supersedeKey: (payload) => {
      try {
        const p = contactBlockedPayloadOf(payload);
        return `${p.readerUserId}|${p.to.ref}`;
      } catch {
        return null;
      }
    },
  },
);

/** Can talk with = Always allow, through the reach door (audited, decider
 * stamped), forced like the Contacts control: the blocked card's Allow and
 * a "send as the agent" pick. */
export const allowPerson = async (input: {
  agentId: string;
  to: SendRecipient;
  deciderUserId: string;
}): Promise<void> => {
  const presence = await db.agentChannel.findFirst({
    where: { agentId: input.agentId, status: "active" },
    select: { provider: true, integrationId: true },
  });
  if (!presence || !isChannelProviderId(presence.provider)) {
    throw new Error("no active channel presence");
  }
  const grant = await ensurePersonGrant({
    agentId: input.agentId,
    integrationId: presence.integrationId,
    provider: presence.provider,
    externalRef: input.to.ref,
    subjectLabel: input.to.label,
  });
  const result = await decideReachGrant({
    grantId: grant.id,
    decision: "approved",
    deciderUserId: input.deciderUserId,
    force: true,
  });
  if (result.kind === "refused") throw new Error(result.message);
};

export type SendOutcome =
  | { kind: "sent"; to: string }
  | { kind: "held"; to: string; approvalId: string }
  /** An earlier ask to this recipient is still undecided: THIS message was
   * not sent and no new card went out. One open ask per recipient keeps
   * the owner from approving two sends to one person. */
  | { kind: "busy"; to: string; approvalId: string }
  /** The contact is blocked and the asking person was shown a card. */
  | { kind: "blocked"; to: string; approvalId: string };

/** Which kind of manager a recipient is: a workspace OWNER (their setting
 * is a fixed Always allow) or the member who ATTACHED the presence. */
type ManagerKind = "owner" | "attacher";

/**
 * Is this provider user the agent's manager: a workspace owner, or the
 * member who attached the active presence, linked to this Slack identity,
 * and still able to reach the agent's workspace? Every hop is a fresh
 * read, so a revoked link, a suspended membership or a lost workspace grant
 * ends the shortcut. Answers which kind, or null.
 *
 * A manager who never DMed their own agent has no link yet. Then the
 * provider's verified email decides: only when it is the attacher's own
 * email does the shared authorizer run, linking them exactly as a first DM
 * would (live org member only). Anyone else is never looked up further and
 * never linked as a side effect of being messaged.
 */
const managerKindOf = async (
  agentId: string,
  externalUserId: string,
): Promise<ManagerKind | null> => {
  const presence = await db.agentChannel.findFirst({
    where: { agentId, status: "active" },
    select: {
      provider: true,
      credentials: true,
      integrationId: true,
      createdByUserId: true,
      createdBy: { select: { email: true } },
      integration: { select: { organizationId: true } },
      agent: {
        select: {
          workspace: { select: { id: true, organizationId: true } },
        },
      },
    },
  });
  if (!presence) return null;
  // A workspace OWNER is always messageable (their Contacts row is a fixed
  // Always allow), so a send to them never asks either.
  const owners = await workspaceOwnerRefs(
    presence.agent.workspace.id,
    presence.integrationId,
  );
  if (owners.has(externalUserId)) return "owner";
  if (!presence.createdByUserId || !presence.createdBy) return null;
  const link = await db.channelUserLink.findUnique({
    where: {
      integrationId_externalUserId: {
        integrationId: presence.integrationId,
        externalUserId,
      },
    },
    select: { userId: true },
  });
  if (link && link.userId !== presence.createdByUserId) return null;
  let email: string | undefined;
  if (!link) {
    if (!isChannelProviderId(presence.provider)) return null;
    const verified = await channelProvider(presence.provider).lookupUserEmail({
      credentialsJson: presence.credentials
        ? await getCrypto().decrypt(presence.credentials)
        : null,
      externalUserId,
    });
    if (
      !verified ||
      verified.trim().toLowerCase() !==
        presence.createdBy.email.trim().toLowerCase()
    ) {
      return null;
    }
    email = verified;
  }
  const authorized = await authorizeChannelUser(
    presence.integrationId,
    presence.integration.organizationId,
    presence.agent.workspace,
    externalUserId,
    email,
  );
  return authorized?.userId === presence.createdByUserId ? "attacher" : null;
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
  /** The verified person asking in their own chat (null = a shared place):
   * a blocked contact raises a card for them instead of a dead end. */
  readerUserId?: string | null;
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

  // BODY mentions, resolved NOW and frozen into the payload: the mirror's
  // own resolve walk (anchors → directory; a blocked person may still be
  // mentioned, they just can't be DMed), so a channel send can carry working pings —
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

  const policy = await recipientPolicyOf(input.agentId, recipient);
  // The agent's MANAGER never needs to approve a message to themselves:
  // asking "may I tell you their answer?" is noise, and that relay is the
  // whole point of the errand. Narrow on purpose: a workspace owner, or the
  // presence's creator while they still hold the workspace (a departed
  // manager is just another recipient); a person, never a channel. Checked
  // once per send.
  const manager =
    recipient.kind === "person"
      ? await managerKindOf(input.agentId, recipient.ref)
      : null;
  if (isRefused(policy, manager)) {
    if (recipient.kind === "person" && input.readerUserId) {
      return {
        kind: "blocked",
        to: recipient.label,
        approvalId: await requestContactBlocked({
          agentId: input.agentId,
          readerUserId: input.readerUserId,
          payload,
          originConversationId: input.originConversationId,
          originTurnId: input.originTurnId,
        }),
      };
    }
    // The owner's standing no — terminal for the model, with the reason.
    throw new ServiceError(
      "UNPROCESSABLE",
      recipient.kind === "channel"
        ? `The workspace owner turned you off in ${recipient.label}: you can't post there. Don't retry.`
        : `The workspace owner has blocked messaging ${recipient.label}. Don't retry. ${BLOCKED_HINT}`,
    );
  }
  if (policy === "allow" || manager) {
    await executeSend(input.agentId, payload, {
      manager,
      originConversationId: input.originConversationId,
      originTurnId: input.originTurnId,
    });
    log.info(
      { agentId: input.agentId, kind: recipient.kind },
      manager
        ? "send_message delivered (to the agent's manager)"
        : "send_message delivered (always allowed)",
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
    // The card asks about the recipient (Always allow / Never), with the
    // first message as context.
    summary:
      recipient.kind === "channel"
        ? `post in ${recipient.label} from now on? First post: "${text}"`
        : `message ${recipient.label} from now on? First message: "${text}"`,
  });
  return { kind: "held", to: recipient.label, approvalId: held.id };
};

/** Is this recipient blocked for the agent's own messages (Never, and not
 * a workspace owner)? Read fresh: a remembered "send as the agent" whose
 * setting was set to Never since is forgotten. */
export const isRecipientBlocked = async (
  agentId: string,
  recipient: SendRecipient,
): Promise<boolean> =>
  isRefused(
    await recipientPolicyOf(agentId, recipient),
    recipient.kind === "person"
      ? await managerKindOf(agentId, recipient.ref)
      : null,
  );

/** Open (or reuse) the blocked-contact card for this exact send. */
const requestContactBlocked = async (input: {
  agentId: string;
  readerUserId: string;
  payload: SendPayload;
  originConversationId: string | null;
  originTurnId: string | null;
}): Promise<string> => {
  const pending = await db.actionApproval.findMany({
    where: {
      agentId: input.agentId,
      action: CONTACT_BLOCKED_ACTION,
      status: "pending",
      expiresAt: { gt: new Date() },
      AND: [
        { payload: { path: ["to", "ref"], equals: input.payload.to.ref } },
        { payload: { path: ["readerUserId"], equals: input.readerUserId } },
        { payload: { path: ["text"], equals: input.payload.text } },
      ],
    },
    select: { id: true },
    take: 1,
  });
  if (pending[0]) return pending[0].id;
  const ask = await personalAskOf(input.agentId, input.readerUserId);
  const held = await requestActionApproval({
    agentId: input.agentId,
    conversationId: input.originConversationId,
    originTurnId: input.originTurnId,
    action: CONTACT_BLOCKED_ACTION,
    // The same bridge as the send hold: SendPayload is plain JSON data.
    payload: { ...input.payload, ...ask } as unknown as Prisma.InputJsonValue,
    summary: contactBlockedSummary(ask.agentName, input.payload.to.label),
  });
  return held.id;
};

/** Who asks a personal card, ready to freeze into it: the reader, their
 * Slack id on the agent's active presence ("" when not linked: the card
 * then lives in the dashboard only), and the agent's name. */
export const personalAskOf = async (
  agentId: string,
  readerUserId: string,
): Promise<z.infer<typeof personalAskSchema>> => {
  const [agent, link] = await Promise.all([
    db.agent.findUniqueOrThrow({
      where: { id: agentId },
      select: { name: true },
    }),
    db.channelUserLink.findFirst({
      where: {
        userId: readerUserId,
        integration: { agentChannels: { some: { agentId, status: "active" } } },
      },
      select: { externalUserId: true },
    }),
  ]);
  return {
    readerUserId,
    readerExternalUserId: link?.externalUserId ?? "",
    agentName: agent.name,
  };
};

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
