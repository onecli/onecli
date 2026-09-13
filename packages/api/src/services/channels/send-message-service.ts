import { db, Prisma } from "@onecli/db";
import { mentionNamesOf, normalizeMentionName } from "@onecli/channels";
import {
  conversationsOpen,
  markdownToMrkdwn,
  postMessage,
} from "@onecli/channels/slack";
import { getCrypto } from "../../providers";
import { ServiceError } from "../errors";
import {
  registerActionHandler,
  requestActionApproval,
} from "./action-approval-service";
import { resolveMentionNames } from "./mention-resolution-service";
import { findChannels } from "./recipient-search-service";
import { logger } from "../../lib/logger";

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
    where: { agentId, provider: "slack", status: "active" },
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

/** The contact policy for one recipient — no row means `ask` (the default:
 * every send to an undecided recipient holds for the owner). `blocked`
 * (4e) is the owner's standing NO: refused before any card. */
const policyOf = async (
  agentId: string,
  recipient: SendRecipient,
): Promise<"ask" | "allow" | "blocked"> => {
  const contact = await db.agentContact.findUnique({
    where: {
      agentId_kind_externalRef: {
        agentId,
        kind: recipient.kind,
        externalRef: recipient.ref,
      },
    },
    select: { policy: true },
  });
  if (contact?.policy === "allow") return "allow";
  if (contact?.policy === "blocked") return "blocked";
  return "ask";
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
 * Execute one frozen send — the registered 4b handler. Bounded-fast (one
 * render + one or two Slack calls), per the handler contract. Throws into
 * the approval service's failure arm on any miss: the owner's card then
 * reads "approved, but it failed — the agent was told", which is the honest
 * outcome for a revoked credential or a deleted channel.
 */
const executeSend = async (agentId: string, payload: SendPayload) => {
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
    where: { agentId, provider: "slack", status: "active" },
    select: { id: true, credentials: true },
  });
  if (!presence?.credentials) {
    throw new Error("no active channel presence to send from");
  }
  const credentials = JSON.parse(
    await getCrypto().decrypt(presence.credentials),
  ) as { botToken?: string };
  if (!credentials.botToken) throw new Error("presence has no bot token");

  // People are addressed via their DM channel (conversations.open is
  // idempotent — it returns the existing IM); channels post directly.
  // People AND apps are addressed via their DM channel (an app's bot user
  // opens an IM the same way); channels post directly.
  const channel =
    payload.to.kind === "channel"
      ? payload.to.ref
      : (await conversationsOpen(credentials.botToken, payload.to.ref)).channel
          .id;

  // The same renderer the mirror trusts, with the map FROZEN at request
  // time: body @[Name] tokens ping exactly who was resolved when the owner
  // read the card — never re-resolved at execute (rename-proof, the anchor
  // philosophy). Tokens without a map entry degrade to visible plain text.
  const text = markdownToMrkdwn(
    payload.text,
    payload.mentions
      ? { mentions: new Map(Object.entries(payload.mentions)) }
      : undefined,
  );
  await postMessage(credentials.botToken, { channel, text });
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
    await executeSend(approval.agentId, payloadOf(approval.payload));
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
  | { kind: "held"; to: string; approvalId: string };

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
      where: { agentId: input.agentId, provider: "slack", status: "active" },
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

  const policy = await policyOf(input.agentId, recipient);
  if (policy === "blocked") {
    // The owner's standing no — terminal for the model, with the reason.
    throw new ServiceError(
      "UNPROCESSABLE",
      `The workspace owner has blocked messaging ${recipient.label}. Don't retry.`,
    );
  }
  if (policy === "allow") {
    await executeSend(input.agentId, payload);
    log.info(
      { agentId: input.agentId, kind: recipient.kind },
      "send_message delivered (allow contact)",
    );
    return { kind: "sent", to: recipient.label };
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
