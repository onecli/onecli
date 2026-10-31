import { db, type Prisma } from "@onecli/db";
import { z } from "zod";
import {
  getConversationSender,
  type ActAsYouOutcome,
} from "../../providers/hooks/conversation-reader";
import { enterpriseLicenseMessage } from "../../lib/entitlements-guard";
import { cleanLabel } from "../../lib/format";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "../audit-service";
import { userDisplayName } from "../user-service";
import {
  onActionAbandoned,
  registerActionHandler,
  requestActionApproval,
  supersedeActionApprovals,
} from "./action-approval-service";
import {
  allowPerson,
  CONTACT_BLOCKED_ACTION,
  contactBlockedPayloadOf,
  isRecipientBlocked,
  personalAskOf,
  personalAskSchema,
  requestSend,
  resolveSendRecipient,
  type SendRecipient,
} from "./send-message-service";
import {
  SENDER_CHOICES,
  type SendAs,
  type SenderChoice,
} from "../../validations/recipients";
import {
  SLACK_ACCESS_ACTION,
  slackAccessPayloadSchema,
} from "../../validations/slack-access";

/**
 * "Send as the agent, or as you?" — send_message's sender choice.
 *
 * The PLATFORM asks, never the agent: with sendAs "ask" and both senders
 * possible (a verified reader in their own chat, a live Slack presence, the
 * act-as-you license), the person gets ONE question per recipient: "How
 * should <Agent> message <Name>?". The pick changes the real setting
 * (Contacts' Can talk with = Always allow, or writing allowed as you) and
 * is remembered, so the next send there skips the card. A setting changed
 * to Never in Contacts forgets the pick, and the next send asks again.
 * An explicit sendAs ("as you" / "as <agent>") overrides and updates it.
 * This file never posts as a person itself.
 */

export const CHOOSE_SENDER_ACTION = "channel.choose_sender";

/** send_message's promise about replies (the agent path). */
const REPLY_COMES_BACK =
  "If they reply, you'll be told what you sent them and where it was asked from; pass the answer on then. Don't ask anyone to check back later.";

/** "You are talking with <Name>." for a note the agent relays. */
const youNamed = async (userId: string | null): Promise<string> => {
  const name = userId ? await userDisplayName(userId) : null;
  return name
    ? `You are talking with ${name} (address them as "you (${name})").`
    : "";
};

/** The frozen choose-sender payload: the exact send, who decides, and the
 * recipient resolved at ask time (its id is what "As me" targets). */
const chooseSenderPayloadSchema = personalAskSchema.extend({
  to: z.string(),
  text: z.string(),
  recipient: z.object({
    kind: z.enum(["person", "channel"]),
    ref: z.string().min(1),
    label: z.string(),
  }),
});
type ChooseSenderPayload = z.infer<typeof chooseSenderPayloadSchema>;

export const chooseSenderPayloadOf = (
  raw: Prisma.JsonValue,
): ChooseSenderPayload => chooseSenderPayloadSchema.parse(raw);

const agentLabel = (name: string) => cleanLabel(name, 80) || "the agent";

/** The card's words: server-built, with a preview of the exact message. */
const chooseSenderSummary = (p: ChooseSenderPayload) =>
  `How should ${agentLabel(p.agentName)} message ${p.recipient.label}? "${cleanLabel(p.text, 300)}"`;

/** The card's buttons. */
const chooseSenderChoices = (agentName: string) => [
  { value: "agent", label: `As ${agentLabel(agentName)}` },
  { value: "you", label: "As me" },
];

// ── Preferences ────────────────────────────────────────────────────────────

const isSenderChoice = (v: string): v is SenderChoice =>
  (SENDER_CHOICES as readonly string[]).includes(v);

const prefKey = (input: {
  agentId: string;
  userId: string;
  recipientRef: string;
}) => ({
  agentId_userId_recipientRef: {
    agentId: input.agentId,
    userId: input.userId,
    recipientRef: input.recipientRef,
  },
});

const getSendAsPreference = async (input: {
  agentId: string;
  userId: string;
  recipientRef: string;
}): Promise<SenderChoice | null> => {
  const row = await db.agentSendAsPreference.findUnique({
    where: prefKey(input),
    select: { sendAs: true },
  });
  return row && isSenderChoice(row.sendAs) ? row.sendAs : null;
};

/** Store a person's sender for one recipient. Returns the value it
 * replaced (null = none). */
const setSendAsPreference = async (input: {
  agentId: string;
  userId: string;
  recipientRef: string;
  sendAs: SenderChoice;
}): Promise<SenderChoice | null> => {
  const before = await getSendAsPreference(input);
  if (before === input.sendAs) return before;
  await db.agentSendAsPreference.upsert({
    where: prefKey(input),
    create: {
      agentId: input.agentId,
      userId: input.userId,
      recipientRef: input.recipientRef,
      sendAs: input.sendAs,
    },
    update: { sendAs: input.sendAs },
  });
  return before;
};

/** The caller's own preferences on one agent (Contacts). */
export const listSendAsPreferences = (agentId: string, userId: string) =>
  db.agentSendAsPreference.findMany({
    where: { agentId, userId },
    select: { recipientRef: true, sendAs: true },
    orderBy: { createdAt: "asc" },
  });

/** Forget the caller's own preference for one recipient (audited). */
export const forgetSendAsPreference = async (input: {
  workspaceId: string;
  agentId: string;
  userId: string;
  userEmail: string;
  recipientRef: string;
}): Promise<boolean> => {
  const { count } = await db.agentSendAsPreference.deleteMany({
    where: {
      agentId: input.agentId,
      userId: input.userId,
      recipientRef: input.recipientRef,
    },
  });
  if (count > 0) {
    await recordAuditEvent({
      workspaceId: input.workspaceId,
      userId: input.userId,
      userEmail: input.userEmail,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.CHANNEL,
      source: AUDIT_SOURCE.API,
      metadata: {
        agentId: input.agentId,
        recipientRef: input.recipientRef,
        setting: "send_as_preference",
      },
    });
  }
  return count > 0;
};

// ── The two paths ──────────────────────────────────────────────────────────

interface SendContext {
  agentId: string;
  to: string;
  text: string;
  originConversationId: string | null;
  originTurnId: string | null;
  readerUserId: string | null;
  askerUserId: string | null;
}

/** send_message as the agent: today's behavior, verbatim. */
const sendAsAgentPath = async (
  input: SendContext,
): Promise<ActAsYouOutcome> => {
  const outcome = await requestSend({
    agentId: input.agentId,
    to: input.to,
    text: input.text,
    originConversationId: input.originConversationId,
    originTurnId: input.originTurnId,
    readerUserId: input.readerUserId,
  });
  switch (outcome.kind) {
    case "blocked":
      return {
        ok: true,
        result: {
          status: "needs_access",
          blocked: true,
          to: outcome.to,
          accessRequestId: outcome.approvalId,
          note: `Not sent: ${outcome.to} is blocked from talking with you. ${await youNamed(input.readerUserId)} A card in this chat asks you whether to allow it; if you allow it, the message is sent and you continue on your own. Tell the person in one short line, addressed as "you", never "them". A block never affects sending as them.`,
        },
      };
    case "sent":
      return {
        ok: true,
        result: {
          status: "sent",
          to: outcome.to,
          note: `Delivered. ${REPLY_COMES_BACK}`,
        },
      };
    case "busy":
      return {
        ok: true,
        result: {
          status: "not_sent",
          to: outcome.to,
          note: `Not sent. An earlier message to ${outcome.to} is still waiting for the owner's approval, and only one can wait at a time. This message was dropped, not queued. Once the decision arrives as a notice here, send it again if it still matters.`,
        },
      };
    case "held":
      return {
        ok: true,
        result: {
          status: "held",
          to: outcome.to,
          note: `Waiting for the workspace owner's approval; the decision arrives as a notice in this conversation. ${REPLY_COMES_BACK} If you mention it, one short line (e.g. "Sent for approval, I'll pass on the answer."); don't explain the approval process.`,
        },
      };
  }
};

/**
 * send_message as the person: the act-as-you sender (licensed seam). The
 * recipient was resolved by id, so the target is that exact conversation
 * (their DM with that person, or that channel), never a name lookalike.
 */
const sendAsYouPath = (
  input: SendContext & { recipient: SendRecipient; picked?: boolean },
): Promise<ActAsYouOutcome> => {
  const sender = getConversationSender();
  if (!sender) {
    return Promise.resolve({
      ok: false,
      error: enterpriseLicenseMessage("granular_access"),
    });
  }
  return sender.send({
    agentId: input.agentId,
    readerUserId: input.readerUserId,
    askerUserId: input.askerUserId,
    conversation:
      input.recipient.kind === "person"
        ? `@${input.recipient.label}`
        : input.recipient.label,
    conversationRef: input.recipient.ref,
    text: input.text,
    originConversationId: input.originConversationId,
    originTurnId: input.originTurnId,
    ...(input.picked && { consented: true }),
  });
};

/** Can this turn be offered both senders? */
const bothSendersPossible = async (
  agentId: string,
  readerUserId: string | null,
): Promise<boolean> => {
  if (!readerUserId) return false;
  const sender = getConversationSender();
  return sender !== null && (await sender.available(agentId));
};

/** Tag a result with who sent and whether a preference drove it. */
const tagged = (
  outcome: ActAsYouOutcome,
  extra: Record<string, unknown>,
): ActAsYouOutcome =>
  outcome.ok ? { ok: true, result: { ...outcome.result, ...extra } } : outcome;

/**
 * The send_message tool's body. "agent" and "you" run that path (and, when
 * both senders were possible, remember it for this recipient); "ask" uses
 * the remembered sender, or raises the choose-sender card, or (only one
 * sender possible) sends as the agent.
 */
export const sendMessageWithSender = async (
  input: SendContext & { sendAs: SendAs },
): Promise<ActAsYouOutcome> => {
  if (input.sendAs === "you" && !getConversationSender()) {
    return { ok: false, error: enterpriseLicenseMessage("granular_access") };
  }
  const both = await bothSendersPossible(input.agentId, input.readerUserId);
  if (!both) {
    if (input.sendAs === "you") {
      // Unavailable here (a shared place, or no live Slack): the sender
      // gives the honest refusal; never a silent switch to the agent.
      const recipient = await resolveSendRecipient(
        input.agentId,
        input.to,
        input.originConversationId,
      );
      return sendAsYouPath({ ...input, recipient });
    }
    return sendAsAgentPath(input);
  }
  const readerUserId = input.readerUserId!;
  const recipient = await resolveSendRecipient(
    input.agentId,
    input.to,
    input.originConversationId,
  );
  const run = (choice: SenderChoice) =>
    choice === "you"
      ? sendAsYouPath({ ...input, recipient })
      : sendAsAgentPath(input);
  const pref = {
    agentId: input.agentId,
    userId: readerUserId,
    recipientRef: recipient.ref,
  };

  if (input.sendAs !== "ask") {
    const before = await setSendAsPreference({
      ...pref,
      sendAs: input.sendAs,
    });
    const updated = before !== null && before !== input.sendAs;
    return tagged(await run(input.sendAs), {
      sendAs: input.sendAs,
      ...(updated && {
        preferenceUpdated: true,
        preferenceNote: `The person switched: from now on, messages to ${recipient.label} go ${input.sendAs === "you" ? "as them" : "as you (the agent)"}. Say so in one short line.`,
      }),
    });
  }

  const remembered = await getSendAsPreference(pref);
  // The preference stands on a real setting ("agent" = Can talk with is
  // Always allow, "you" = writing allowed). Set to Never in Contacts since,
  // it is forgotten and the person is asked again.
  const forget = () => db.agentSendAsPreference.deleteMany({ where: pref });
  if (
    remembered === "agent" &&
    (await isRecipientBlocked(input.agentId, recipient))
  ) {
    await forget();
  } else if (remembered) {
    const outcome = await run(remembered);
    if (
      remembered === "you" &&
      outcome.ok &&
      outcome.result.reason === "write_off"
    ) {
      // The access card it raised is moot: the sender question replaces it.
      await supersedeStaleAccessCards({ ...input, readerUserId, recipient });
      await forget();
      return requestChooseSender({ ...input, readerUserId, recipient });
    }
    const agent = await db.agent.findUnique({
      where: { id: input.agentId },
      select: { name: true },
    });
    const other =
      remembered === "you" ? `as ${agentLabel(agent?.name ?? "")}` : "as me";
    return tagged(outcome, {
      sendAs: remembered,
      remembered: true,
      preferenceNote: `Sent ${remembered === "you" ? "as the person" : "as you (the agent)"} because that is their usual for ${recipient.label}. When you confirm, mention it briefly, e.g. "${remembered === "you" ? "Sent as you" : "Sent"} to ${recipient.label} (your usual for ${recipient.label}, say '${other}' to switch)".`,
    });
  }

  return requestChooseSender({ ...input, readerUserId, recipient });
};

/** Open (or reuse) the choose-sender card and answer needs_choice. */
const requestChooseSender = async (
  input: SendContext & { readerUserId: string; recipient: SendRecipient },
): Promise<ActAsYouOutcome> => {
  const pending = await db.actionApproval.findFirst({
    where: {
      agentId: input.agentId,
      action: CHOOSE_SENDER_ACTION,
      status: "pending",
      expiresAt: { gt: new Date() },
      AND: [
        {
          payload: { path: ["recipient", "ref"], equals: input.recipient.ref },
        },
        { payload: { path: ["readerUserId"], equals: input.readerUserId } },
        { payload: { path: ["text"], equals: input.text } },
      ],
    },
    select: { id: true },
  });
  // A fresher ask for this recipient replaces the person's still-pending
  // "connect / allow writing" card for it: one card to act on, not two.
  await supersedeStaleAccessCards(input);
  const ask = await personalAskOf(input.agentId, input.readerUserId);
  const payload: ChooseSenderPayload = {
    ...ask,
    to: input.to,
    text: input.text,
    recipient: input.recipient,
  };
  const id =
    pending?.id ??
    (
      await requestActionApproval({
        agentId: input.agentId,
        conversationId: input.originConversationId,
        originTurnId: input.originTurnId,
        action: CHOOSE_SENDER_ACTION,
        payload: { ...payload, recipient: { ...payload.recipient } },
        summary: chooseSenderSummary(payload),
      })
    ).id;
  const name = await userDisplayName(input.readerUserId);
  const agent = agentLabel(ask.agentName);
  return {
    ok: true,
    result: {
      status: "needs_choice",
      to: input.recipient.label,
      choiceRequestId: id,
      note: `Not sent yet. A card in this chat asks you${name ? ` (${name})` : ""} how ${agent} should message ${input.recipient.label}: as ${agent} or as you. The message goes out when you pick (the pick is the approval and is saved in Contacts; the platform sends it and tells you the outcome). Tell the person in one short line, addressed as "you". Don't send it again.`,
    },
  };
};

/**
 * The card's handler: the pick changes the real setting, so Contacts always
 * shows it. "agent" = Can talk with is Always allow (the Contacts door,
 * audited); "you" = writing allowed in that conversation (connect first
 * when needed). Then the pick is stored and the frozen message sent.
 */
registerActionHandler(
  CHOOSE_SENDER_ACTION,
  async (approval, context) => {
    const p = chooseSenderPayloadOf(approval.payload);
    const choice: SenderChoice = context.choice === "you" ? "you" : "agent";
    const ctx: SendContext = {
      agentId: approval.agentId,
      to: p.to,
      text: p.text,
      originConversationId: approval.conversationId,
      originTurnId: approval.originTurnId,
      readerUserId: p.readerUserId,
      askerUserId: p.readerUserId,
    };
    if (choice === "agent") {
      if (p.recipient.kind === "person") {
        await allowPerson({
          agentId: approval.agentId,
          to: p.recipient,
          deciderUserId: p.readerUserId,
        });
      }
      // The person's pending "connect your Slack" card for it is moot now.
      await supersedeStaleAccessCards({
        agentId: approval.agentId,
        readerUserId: p.readerUserId,
        recipient: p.recipient,
      });
    }
    await setSendAsPreference({
      agentId: approval.agentId,
      userId: p.readerUserId,
      recipientRef: p.recipient.ref,
      sendAs: choice,
    });
    const outcome =
      choice === "you"
        ? await sendAsYouPath({ ...ctx, recipient: p.recipient, picked: true })
        : await sendAsAgentPath(ctx);
    if (!outcome.ok) throw new Error(outcome.error);
    const who = choice === "you" ? "you" : agentLabel(p.agentName);
    const quoted = `"${cleanLabel(p.text, 200)}"`;
    const status = outcome.result.status;
    if (status === "sent") {
      return {
        note: `Sent as ${who} to ${p.recipient.label}: ${quoted}`,
        resume: `Sent as ${who} to ${p.recipient.label}: ${quoted}. Already delivered: don't send it again. Confirm in one short line and continue the original request.`,
      };
    }
    if (status === "held") {
      return {
        note: `Waiting for approval to send to ${p.recipient.label}.`,
        chained: true,
      };
    }
    if (status === "not_sent") {
      return {
        note: `Not sent to ${p.recipient.label}: an earlier message there is still waiting for approval.`,
        resume: `Not sent to ${p.recipient.label}: an earlier message there is still waiting for approval. Tell the person in one short line; never say it was sent.`,
      };
    }
    // Sending as you needs one more step (connect your Slack): that card's
    // outcome resumes the agent.
    return {
      note: `One more step: ${
        outcome.result.reason === "reconnect_for_write"
          ? "reconnect your Slack so the message can go as you."
          : "connect your Slack so the message can go as you."
      }`,
      chained: true,
    };
  },
  {
    decidedBy: (payload) => {
      const p = chooseSenderPayloadSchema.safeParse(payload);
      return p.success
        ? {
            userId: p.data.readerUserId,
            externalUserId: p.data.readerExternalUserId,
          }
        : null;
    },
    choices: (payload) => {
      const p = chooseSenderPayloadSchema.safeParse(payload);
      return p.success ? chooseSenderChoices(p.data.agentName) : [];
    },
    // No Slack link yet = nowhere to DM the card: the chat card only.
    dmCard: (payload) => {
      const p = chooseSenderPayloadSchema.safeParse(payload);
      return p.success && p.data.readerExternalUserId !== "";
    },
    resumeOnExecute: true,
    noteIsOutcome: true,
    supersedeKey: (payload) => {
      const p = chooseSenderPayloadSchema.safeParse(payload);
      return p.success
        ? `${p.data.readerUserId}|${p.data.recipient.ref}`
        : null;
    },
  },
);

/** The person's pending write-access cards (connect / share / allow
 * writing) aimed at this recipient, by its id. */
const pendingAccessCardsFor = async (input: {
  agentId: string;
  readerUserId: string;
  recipient: SendRecipient;
}): Promise<string[]> => {
  const rows = await db.actionApproval.findMany({
    where: {
      agentId: input.agentId,
      action: SLACK_ACCESS_ACTION,
      status: "pending",
      payload: { path: ["readerUserId"], equals: input.readerUserId },
    },
    select: { id: true, payload: true },
  });
  return rows.flatMap((row) => {
    const p = slackAccessPayloadSchema.safeParse(row.payload);
    return p.success &&
      p.data.kind === "write" &&
      p.data.conversationRef === input.recipient.ref
      ? [row.id]
      : [];
  });
};

const supersedeStaleAccessCards = async (input: {
  agentId: string;
  readerUserId: string;
  recipient: SendRecipient;
}) => {
  try {
    await supersedeActionApprovals(await pendingAccessCardsFor(input));
  } catch {
    // Best-effort: a stale card left over is noise, never a wrong send.
  }
};

/**
 * A pick that chained into another card, then went nowhere (Not now,
 * failed, expired): the sender it stored for that recipient is undone,
 * since the person never got a send that way. Matched on the exact frozen
 * send (reader, recipient id, text) of an executed choose-sender row.
 */
const undoChainedPick = async (input: {
  agentId: string;
  readerUserId: string;
  recipientRef: string;
  text: string;
}): Promise<SendRecipient | null> => {
  const row = await db.actionApproval.findFirst({
    where: {
      agentId: input.agentId,
      action: CHOOSE_SENDER_ACTION,
      status: "executed",
      AND: [
        { payload: { path: ["readerUserId"], equals: input.readerUserId } },
        {
          payload: { path: ["recipient", "ref"], equals: input.recipientRef },
        },
        { payload: { path: ["text"], equals: input.text } },
      ],
    },
    select: { payload: true },
    orderBy: { updatedAt: "desc" },
  });
  const p = row ? chooseSenderPayloadSchema.safeParse(row.payload) : null;
  if (!p?.success) return null;
  await db.agentSendAsPreference.deleteMany({
    where: {
      agentId: input.agentId,
      userId: input.readerUserId,
      recipientRef: input.recipientRef,
      sendAs: "you",
    },
  });
  return p.data.recipient;
};

onActionAbandoned(SLACK_ACCESS_ACTION, async (approval, outcome) => {
  const parsed = slackAccessPayloadSchema.safeParse(approval.payload);
  if (
    !parsed.success ||
    parsed.data.kind !== "write" ||
    !parsed.data.text ||
    !parsed.data.conversationRef
  ) {
    return null;
  }
  const recipient = await undoChainedPick({
    agentId: approval.agentId,
    readerUserId: parsed.data.readerUserId,
    recipientRef: parsed.data.conversationRef,
    text: parsed.data.text,
  });
  if (!recipient || outcome === "expired") return null;
  return outcome === "rejected"
    ? `Not sent to ${recipient.label}: you didn't continue sending it as you.`
    : `Not sent to ${recipient.label}: sending it as you failed.`;
});

/** Don't send on either question: nothing went out, and the agent hears so. */
const notSent =
  (recipientOf: (payload: Prisma.JsonValue) => string) =>
  async (
    approval: { payload: Prisma.JsonValue },
    outcome: "rejected" | "expired" | "failed",
  ) =>
    outcome === "rejected"
      ? `Not sent to ${recipientOf(approval.payload)}: you chose Don't send.`
      : null;

onActionAbandoned(
  CHOOSE_SENDER_ACTION,
  notSent((p) => chooseSenderPayloadOf(p).recipient.label),
);
onActionAbandoned(
  CONTACT_BLOCKED_ACTION,
  notSent((p) => contactBlockedPayloadOf(p).to.label),
);
