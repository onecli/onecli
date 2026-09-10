import { normalizeMentionName } from "@onecli/channels";
import type {
  AdapterMentionReportRequest,
  AdapterMentionResolution,
} from "@onecli/agent-protocol";
import { db, Prisma } from "@onecli/db";
import { ServiceError } from "../errors";
import { getEventBus } from "../../providers/event-bus";
import type { PublishedEvent } from "../event-bus";

/**
 * OUTBOUND mention resolution — the control-plane half of the `@[Name]`
 * contract (the adapter's renderer is the other half).
 *
 * The directory is LINKED TEAMMATES ONLY: `ChannelUserLink` rows on this
 * presence's integration, joined to the platform `User` they were verified
 * against. That is the decision record, not a stopgap shortcut:
 *
 *  - a link is an identity the PLATFORM verified (email match or an owner's
 *    manual link) — resolving against it can never ping someone the
 *    workspace has no relationship with;
 *  - the matched name is the PLATFORM name, the same one inbound decoding
 *    shows the model (provider display names are attacker-chosen; using
 *    them here would let a hostile rename steal someone's mentions);
 *  - strangers are the `find_recipient` tool's job (the roadmap's next PR):
 *    discovery is an explicit model action with its own guardrails, never a
 *    renderer side effect.
 *
 * Matching is EXACT on the normalized form (`normalizeMentionName`: trim,
 * collapse whitespace, casefold). Two linked users with the same normalized
 * name answer `ambiguous` with both display names — refusing is the point;
 * a "pick one" heuristic pings the wrong person, the worst failure mode.
 */

export interface MentionDirectoryEntry {
  externalUserId: string;
  displayName: string;
}

/** Strip control characters (normalizeMentionName's whitespace collapse
 * misses non-space controls like ESC), collapse whitespace runs, clamp —
 * every place a display name travels (resolution answers, stored notices,
 * the context note) reads model-visible text. */
const cleanDirectoryName = (raw: string): string =>
  [...raw]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

/**
 * The presence's mention directory: normalized platform name → the linked
 * identities bearing it. Users with no usable name (null and no email
 * fallback) are unmentionable rather than guessable.
 *
 * Small by construction (a workspace's linked teammates), read whole — the
 * same shape every resolve and the context note both need, so one query
 * serves both callers.
 */
export const mentionDirectoryOf = async (
  integrationId: string,
): Promise<Map<string, MentionDirectoryEntry[]>> => {
  const links = await db.channelUserLink.findMany({
    where: { integrationId },
    select: {
      externalUserId: true,
      user: { select: { name: true, email: true } },
    },
  });
  const directory = new Map<string, MentionDirectoryEntry[]>();
  for (const link of links) {
    // The platform name, email as the unnamed-user fallback (the ingestion
    // door's own precedence) — CLEANED before it can ride into the model's
    // context note or a stored notice: platform names are user-controlled
    // text, and a name is not a place for terminal escapes or fabricated
    // lines (the same posture as ingestion's cleanName).
    const displayName = cleanDirectoryName(
      link.user.name?.trim() || link.user.email,
    );
    const key = normalizeMentionName(displayName);
    if (!key) continue;
    const entry = { externalUserId: link.externalUserId, displayName };
    const existing = directory.get(key);
    if (existing) existing.push(entry);
    else directory.set(key, [entry]);
  }
  return directory;
};

/** The route re-caps regardless of what the client sent — neither side
 * trusts the other's bound (the wire schema caps at 20 too). */
const MAX_NAMES = 20;

export const resolveMentionNames = async (
  presenceId: string,
  names: string[],
  conversationId?: string,
): Promise<AdapterMentionResolution[]> => {
  const presence = await db.agentChannel.findUnique({
    where: { id: presenceId },
    select: { integrationId: true, agentId: true },
  });
  if (!presence) throw new ServiceError("NOT_FOUND", "Presence not found");

  const directory = await mentionDirectoryOf(presence.integrationId);

  // The owner's per-recipient BLOCK list (agent_contacts, policy "blocked",
  // 4e): a blocked ref must neither ping nor send. Read once per resolve —
  // small by construction (blocks are rare, deliberate acts).
  const blockedRefs = new Set(
    (
      await db.agentContact.findMany({
        where: { agentId: presence.agentId, policy: "blocked" },
        select: { externalRef: true },
      })
    ).map((c) => c.externalRef),
  );

  // The conversation's ANCHORS — find_recipient picks (name → provider user
  // id). Consulted BEFORE the directory: an anchor is the agent's explicit,
  // id-bound choice from a lookup, so it wins over a coincidental directory
  // name and it is what makes UNLINKED people mentionable at all. The id
  // was fixed at pick time — a display-name rename between lookup and send
  // changes nothing (the anti-impersonation property of the whole design).
  const anchors =
    conversationId === undefined
      ? new Map<string, { externalUserId: string; displayName: string }>()
      : new Map(
          (
            await db.mentionAnchor.findMany({
              // The conversation must belong to THIS presence's agent — the
              // adapter always sends a matching pair, but the projection is
              // never the authority (the host re-checks its own inputs). A
              // mismatched pair resolves directory-only, exactly as if no
              // conversation was named.
              where: {
                conversationId,
                conversation: { agentId: presence.agentId },
              },
              select: { name: true, externalUserId: true, displayName: true },
            })
          ).map((anchor) => [
            anchor.name,
            {
              externalUserId: anchor.externalUserId,
              displayName: anchor.displayName,
            },
          ]),
        );

  return names.slice(0, MAX_NAMES).map((raw): AdapterMentionResolution => {
    const name = normalizeMentionName(raw);
    const anchored = anchors.get(name);
    if (anchored) {
      if (blockedRefs.has(anchored.externalUserId)) {
        // The owner's per-recipient override: a blocked contact must not be
        // pingable — the token degrades to visible plain text, the same
        // loud-failure shape as an unknown name.
        return { kind: "unknown", name };
      }
      return {
        kind: "resolved",
        name,
        externalUserId: anchored.externalUserId,
        displayName: anchored.displayName,
      };
    }
    const matches = directory.get(name) ?? [];
    if (matches.length === 1) {
      const match = matches[0]!;
      if (blockedRefs.has(match.externalUserId)) {
        return { kind: "unknown", name };
      }
      return {
        kind: "resolved",
        name,
        externalUserId: match.externalUserId,
        displayName: match.displayName,
      };
    }
    if (matches.length > 1) {
      return {
        kind: "ambiguous",
        name,
        // Capped at the report wire's own bound (10): a pathological name
        // collision must not make the failure report unpostable.
        candidates: matches.slice(0, 10).map((m) => m.displayName),
      };
    }
    return { kind: "unknown", name };
  });
};

/** One stored mention failure — the shape the context note reads back. */
export type MentionFailure = AdapterMentionReportRequest["failures"][number];

/** Bounds a stored report: the scanner caps names at 20, but the row is
 * written from wire input — cap again, trust nothing. */
const MAX_STORED_FAILURES = 20;

/**
 * Record a turn's mention failures as a durable `notice` event — canonical
 * vocabulary (nothing new for readers to learn), platform-authored, and
 * visible on BOTH surfaces that need it: the web transcript renders the
 * notice text (the person sees why nobody was pinged), and the next turn's
 * context builder reads the structured `mentionFailures` payload field to
 * tell the model exactly which names failed and how.
 *
 * Fenced to linked conversations (the adapter's fence — same posture as the
 * transcript read) and idempotent per turn: a mirror retry or an adapter
 * twin racing the report must not stack duplicate notices.
 */
/**
 * Which of these UNKNOWN-failure names are actually the owner's BLOCK
 * (resolve degrades blocked refs to unknown so nothing pings). Both the
 * failure notice and the next turn's context note must say so, or the
 * model invents its own reason for the plain text (the guy-dev lesson:
 * it blamed the DM). Anchor-scoped to the conversation, agentId-fenced.
 */
const blockedNamesAmong = async (
  conversationId: string,
  agentId: string,
  unknownNames: string[],
): Promise<Set<string>> => {
  const blocked = new Set<string>();
  const names = unknownNames.map((name) => normalizeMentionName(name));
  if (names.length === 0) return blocked;
  const anchors = await db.mentionAnchor.findMany({
    where: { conversationId, name: { in: names } },
    select: { name: true, externalUserId: true },
  });
  if (anchors.length === 0) return blocked;
  const blockedRefs = new Set(
    (
      await db.agentContact.findMany({
        where: {
          agentId,
          policy: "blocked",
          externalRef: { in: anchors.map((a) => a.externalUserId) },
        },
        select: { externalRef: true },
      })
    ).map((c) => c.externalRef),
  );
  for (const anchor of anchors) {
    if (blockedRefs.has(anchor.externalUserId)) blocked.add(anchor.name);
  }
  return blocked;
};

export const recordMentionFailures = async (
  turnId: string,
  failures: MentionFailure[],
): Promise<void> => {
  if (failures.length === 0) return;
  // Wire-borne text: the names came from the model's own answer and the
  // candidates from this service — but the adapter is a separate deployable
  // (version skew is real), so clean both before they enter a durable
  // notice and the next turn's context.
  const capped: MentionFailure[] = failures
    .slice(0, MAX_STORED_FAILURES)
    .map((failure) =>
      failure.kind === "ambiguous"
        ? {
            kind: failure.kind,
            name: cleanDirectoryName(failure.name),
            candidates: failure.candidates
              .slice(0, 10)
              .map((candidate) => cleanDirectoryName(candidate)),
          }
        : { kind: failure.kind, name: cleanDirectoryName(failure.name) },
    );
  const turn = await db.turn.findUnique({
    where: { id: turnId },
    select: {
      conversationId: true,
      conversation: {
        select: { agentId: true, threadLink: { select: { id: true } } },
      },
    },
  });
  if (!turn?.conversation.threadLink) {
    throw new ServiceError("NOT_FOUND", "Turn not found");
  }

  const blockedNames = await blockedNamesAmong(
    turn.conversationId,
    turn.conversation.agentId,
    capped.filter((f) => f.kind === "unknown").map((f) => f.name),
  );

  const lineOf = (failure: MentionFailure): string =>
    failure.kind === "unknown"
      ? blockedNames.has(normalizeMentionName(failure.name))
        ? `@[${failure.name}] posted as plain text: the workspace owner has blocked this recipient. Don't retry - say so plainly if asked.`
        : `@[${failure.name}] didn't match anyone - it posted as plain text. Use find_recipient to get the right form.`
      : failure.kind === "near_miss"
        ? `plain @${failure.name} posted as ordinary text and pinged NOBODY - only the @[${failure.name}] form pings.`
        : `@[${failure.name}] matched ${failure.candidates.length} people (${failure.candidates.join(", ")}) - it posted as plain text.`;

  const lines = capped.map(lineOf);
  const event = {
    type: "notice" as const,
    level: "warn" as const,
    text: lines.join("\n"),
    /** The structured record the next turn's context note is built from —
     * readers of the canonical notice shape ignore it. */
    mentionFailures: capped,
  };

  const published = await db.$transaction(
    async (tx: Prisma.TransactionClient): Promise<PublishedEvent[] | null> => {
      // Idempotency: one mention report per turn. The unique claim is the
      // existing row check under the conversation row-lock taken below - a
      // racing twin serializes on the lastSeq update and sees the winner's row.
      const { lastSeq } = await tx.conversation.update({
        where: { id: turn.conversationId },
        data: { lastSeq: { increment: 1 } },
        select: { lastSeq: true },
      });
      const existing = await tx.turnEvent.findFirst({
        where: { turnId, type: "notice" },
        select: { payload: true },
      });
      if (
        existing &&
        (existing.payload as { mentionFailures?: unknown } | null)
          ?.mentionFailures
      ) {
        return null; // already recorded - the seq is burned, which is fine (gaps are normal)
      }
      await tx.turnEvent.create({
        data: {
          conversationId: turn.conversationId,
          turnId,
          seq: lastSeq,
          type: "notice",
          payload: event as unknown as Prisma.InputJsonValue,
        },
      });
      return [{ seq: lastSeq, turnId, type: "notice", event }];
    },
  );

  // Live web readers see the notice arrive without a refresh.
  if (published) getEventBus().publish(turn.conversationId, published);
};

/**
 * The previous turn's mention failures, for the next turn's context note —
 * exactly one turn's worth: the note describes the model's LAST answer, and
 * an older failure re-surfacing would read as new.
 */
export const mentionFailuresOfPreviousTurn = async (
  conversationId: string,
  before: Date,
): Promise<MentionFailure[]> => {
  const previous = await db.turn.findFirst({
    where: { conversationId, createdAt: { lt: before } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!previous) return [];
  const notices = await db.turnEvent.findMany({
    where: { turnId: previous.id, type: "notice" },
    select: { payload: true },
  });
  for (const notice of notices) {
    const failures = (
      notice.payload as { mentionFailures?: MentionFailure[] } | null
    )?.mentionFailures;
    if (Array.isArray(failures)) return failures;
  }
  return [];
};

/** How many linked names the context note lists. Past this, the note names
 * the count and the rule instead of flooding the budget. */
const NOTE_MAX_NAMES = 25;

/**
 * The turn-start MENTION note for a channel-linked conversation: teaches the
 * syntax (nothing else tells the model it can ping anyone), lists who is
 * mentionable (exact names — the match is exact by design), and reports the
 * PREVIOUS turn's failures so a degraded mention is corrected instead of
 * silently repeated (the Kelly-bug rule: the model must never build beliefs
 * on a ping that did not happen).
 *
 * Delivery-only context, same law as the memory block it rides beside:
 * composed at dispatch from current truth, never stored, and a failure here
 * must never gate the turn (the caller catches).
 */
export const buildMentionContext = async (
  conversationId: string,
  turnCreatedAt: Date,
): Promise<string | null> => {
  const link = await db.channelThreadLink.findUnique({
    where: { conversationId },
    select: {
      kind: true,
      externalUserId: true,
      agentChannel: {
        select: { agentId: true, integrationId: true, provider: true },
      },
    },
  });
  if (!link) return null;

  const [directory, anchors, failures] = await Promise.all([
    mentionDirectoryOf(link.agentChannel.integrationId),
    // This conversation's ANCHORS: find_recipient picks, and apps that
    // spoke here (PR 5a). They resolve ahead of the directory in
    // `resolveMentionNames`, so the list must name them too — otherwise the
    // model cannot know the app it is answering is addressable.
    db.mentionAnchor.findMany({
      where: { conversationId },
      select: { name: true, displayName: true },
    }),
    mentionFailuresOfPreviousTurn(conversationId, turnCreatedAt),
  ]);
  const blockedNames = await blockedNamesAmong(
    conversationId,
    link.agentChannel.agentId,
    failures.filter((f) => f.kind === "unknown").map((f) => f.name),
  );

  const entries = [...directory.values()].flat();
  // One name per normalized key: an anchor and a directory entry for the
  // same person are the same mentionable, listed once.
  const byKey = new Map<string, string>();
  for (const anchor of anchors) byKey.set(anchor.name, anchor.displayName);
  for (const entry of entries) {
    const key = normalizeMentionName(entry.displayName);
    if (key && !byKey.has(key)) byKey.set(key, entry.displayName);
  }
  const names = [...byKey.values()].sort((a, b) => a.localeCompare(b));

  const lines: string[] = [
    "[Mentions: to ping someone in this conversation, write @[Their Name] - brackets included; the platform turns it into a real mention. Plain @name WITHOUT brackets never pings anyone. The name must EXACTLY match a name from the list below or a find_recipient result; for anyone not listed, use find_recipient first - it gives the exact form to write. No match posts as plain text and pings nobody. @here/@channel are not available.",
  ];
  // The DM IDENTITY line. A linked teammate's direct thread carries no
  // speaker prefix (identity IS the conversation — the group door frames
  // `name:` because a room has many voices, a private DM has one), so
  // without this line the model literally cannot answer "who am I?" or
  // "tag me" — the live incident: it reached for a stale memory name
  // instead of the authenticated owner. The name comes from OUR user row
  // via the verified ChannelUserLink (the directory), never the provider
  // profile (display names are attacker-chosen). Guest DMs have
  // externalUserId null by construction and correctly say nothing here —
  // their identity rides the `name (guest):` prefix instead.
  if (link.kind === "direct" && link.externalUserId !== null) {
    const owner = entries.find(
      (entry) => entry.externalUserId === link.externalUserId,
    );
    if (owner) {
      lines.push(
        `This is a direct conversation with ${owner.displayName} - messages here are from them.`,
      );
    }
  }
  if (names.length > 0) {
    const shown = names.slice(0, NOTE_MAX_NAMES);
    const more =
      names.length > shown.length
        ? ` (+${names.length - shown.length} more)`
        : "";
    lines.push(`Mentionable: ${shown.join(", ")}${more}.`);
  } else {
    lines.push(
      "Mentionable: nobody is listed yet - use find_recipient to find and tag people.",
    );
  }
  for (const failure of failures.slice(0, MAX_STORED_FAILURES)) {
    lines.push(
      failure.kind === "unknown"
        ? blockedNames.has(normalizeMentionName(failure.name))
          ? `Note: in your last reply, @[${failure.name}] posted as plain text because the workspace owner has BLOCKED this recipient. Don't retry - say so plainly if asked why.`
          : `Note: in your last reply, @[${failure.name}] didn't match anyone - it posted as plain text and pinged nobody.`
        : failure.kind === "near_miss"
          ? `Note: in your last reply, plain @${failure.name} pinged NOBODY - write @[${failure.name}] to actually ping them.`
          : `Note: in your last reply, @[${failure.name}] was ambiguous (${failure.candidates.join(", ")}) - it posted as plain text and pinged nobody. Use the full name.`,
    );
  }
  return `${lines.join("\n")}]`;
};
