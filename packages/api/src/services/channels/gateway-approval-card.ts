import { db } from "@onecli/db";
import { isChannelProviderId } from "@onecli/channels";
import { getCrypto } from "../../providers";
import { logger } from "../../lib/logger";
import { channelProvider } from "./registry";

const log = logger.child({ component: "gateway-approval-card" });

/**
 * Rewrite the posted channel cards of gateway approvals (the
 * `tool_approval_cards` ledger names where each sits) as one settled line,
 * and mark their ledger rows settled so the adapter's absence arm never
 * relabels them. Best-effort per card: the card is cosmetic, the decision
 * is already delivered at the gateway.
 *
 * A card the adapter grouped holds several requests on ONE message (their
 * ledger rows share its ref), and a line written over it replaces every row.
 * So a grouped card is rewritten only by a line that describes the whole
 * card (`describes: "card"`, e.g. "Replaced by your message") and only once
 * every request on it is named here; anything less leaves it to the
 * adapter, which re-renders a grouped card row by row. A line about one
 * request's own result (`describes: "request"`, e.g. "Created 0 of 9")
 * rewrites single cards only.
 *
 * `onlyPending`: rewrite only cards still pending (a withdrawal, which must
 * never overwrite a card a person already settled by clicking). A follow-up
 * on a card already settled (adding what the approved request did) passes
 * `false`.
 */
export const rewriteGatewayApprovalCards = async (input: {
  /** approval id → its card's settled line. */
  lines: ReadonlyMap<string, string>;
  describes: "card" | "request";
  /** approval id → its request's title, shown before a single card's line. */
  titles?: ReadonlyMap<string, string>;
  onlyPending: boolean;
}): Promise<void> => {
  if (input.lines.size === 0) return;
  const cards = await db.toolApprovalCard.findMany({
    where: {
      approvalId: { in: [...input.lines.keys()] },
      ...(input.onlyPending && { state: "pending" }),
    },
    select: {
      id: true,
      approvalId: true,
      state: true,
      agentChannelId: true,
      externalMessageRef: true,
      agentChannel: { select: { provider: true, credentials: true } },
    },
  });
  const pending = cards.filter((c) => c.state === "pending").map((c) => c.id);
  if (pending.length > 0) {
    await db.toolApprovalCard.updateMany({
      where: { id: { in: pending } },
      data: { state: "decided" },
    });
  }

  // Every request on each touched message, from the same presence's ledger.
  const placed = cards.filter((c) => c.externalMessageRef !== null);
  const sharing = placed.length
    ? await db.toolApprovalCard.findMany({
        where: {
          OR: placed.map((c) => ({
            agentChannelId: c.agentChannelId,
            externalMessageRef: c.externalMessageRef,
          })),
        },
        select: {
          approvalId: true,
          agentChannelId: true,
          externalMessageRef: true,
        },
      })
    : [];

  const done = new Set<string>();
  for (const card of placed) {
    const ref = card.externalMessageRef;
    const message = `${card.agentChannelId}:${ref}`;
    if (!ref || done.has(message)) continue;
    done.add(message);
    const members = sharing.filter(
      (s) =>
        s.agentChannelId === card.agentChannelId &&
        s.externalMessageRef === ref,
    );
    const text = input.lines.get(card.approvalId);
    const single = members.length <= 1;
    const speaksForCard =
      single ||
      (input.describes === "card" &&
        members.every((m) => input.lines.get(m.approvalId) === text));
    if (!text || !speaksForCard) continue;

    const { provider, credentials } = card.agentChannel;
    if (!credentials || !isChannelProviderId(provider)) continue;
    const settle = channelProvider(provider).settleGatewayApprovalCard;
    if (!settle) continue;
    try {
      await settle({
        credentialsJson: await getCrypto().decrypt(credentials),
        externalMessageRef: ref,
        title: single ? input.titles?.get(card.approvalId) : undefined,
        text,
      });
    } catch (err) {
      log.warn(
        { err: String(err), approvalId: card.approvalId },
        "gateway approval card rewrite failed",
      );
    }
  }
};
