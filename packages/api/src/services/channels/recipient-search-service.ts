import { db } from "@onecli/db";
import { normalizeMentionName } from "@onecli/channels";
import { getCrypto } from "../../providers";
import { cleanLabel } from "../../lib/format";
import { mentionDirectoryOf } from "./mention-resolution-service";
import { ServiceError } from "../errors";
import { noteOutboundFailure } from "./agent-channel-service";
import { channelProvider, isChannelProviderId } from "./registry";
import type { ChannelProvider } from "./types";

/**
 * The find_recipient search — the DISCOVERY half of the mention design.
 *
 * The decision record (2026-09-04, with the operator): tagging is not the
 * dangerous act — conversation access is. So discovery and tagging cover the
 * WHOLE connected Slack tenant (linked or not), while who may talk to the
 * agent stays governed by links, reach grants, and consent cards. The
 * renderer's exact-match rule stays fuzzy-free; all fuzziness lives here,
 * where the AGENT (not the platform) picks a candidate, and the pick is
 * anchored to the provider user id — so a display-name rename between
 * lookup and send cannot redirect the ping.
 *
 * Trust labeling: a linked teammate's name comes from OUR user row
 * (verified: true). An unlinked member's name is their self-chosen Slack
 * profile (verified: false) — cleaned and clamped, and the tool output says
 * so, because the model must know which names are governance data and which
 * are claims.
 */

/** Result caps — a discovery answer, not a roster dump. */
const MAX_RESULTS = 8;

export interface RecipientCandidate {
  /** "person" = a human member; "app" = another Slack app's bot user —
   * mentionable (fires its app_mention) and DM-able through the send gate,
   * but invoke-only: bot-authored replies never reach the agent (5a). */
  kind: "person" | "app";
  /** The provider user id — what an anchor binds to. */
  ref: string;
  name: string;
  /** True = the name is OUR verified user row (linked teammate); false =
   * the member's self-chosen Slack profile name. */
  verified: boolean;
}

export interface ChannelCandidate {
  kind: "channel";
  ref: string;
  name: string;
  /** Whether the agent's bot is a member (can read/answer there). */
  member: boolean;
  private: boolean;
}

/** Rank: exact normalized match first, then prefix, then substring; verified
 * beats unverified within a tier (the platform's own names are the better
 * answer for the same rank). */
const rankOf = (candidate: string, query: string): number => {
  if (candidate === query) return 0;
  if (candidate.startsWith(query)) return 1;
  if (candidate.includes(query)) return 2;
  return 3;
};

/** The SEARCH key: the mention normalizer plus separator folding - people
 * type "guy private" for the channel named guy-private, and profile names
 * mix dots and underscores freely (dan.abramov). Separators become spaces
 * for MATCHING only; the returned name keeps its real spelling. */
const searchKeyOf = (raw: string): string =>
  normalizeMentionName(raw.replace(/[-_.]+/g, " "));

const presenceOf = async (agentId: string) => {
  const presence = await db.agentChannel.findFirst({
    where: { agentId, status: "active" },
    select: {
      id: true,
      provider: true,
      integrationId: true,
      credentials: true,
      // The presence's own bot user id — the agent must never discover
      // ITSELF as an app (self-mention = self-invocation, a loop seed).
      identityRef: true,
      integration: { select: { externalId: true } },
    },
  });
  return presence;
};

type Presence = {
  id: string;
  provider: string;
  credentials: string | null;
  identityRef: string | null;
  integration: { externalId: string };
};

/**
 * Ask the presence's provider for one half of its roster. Null when the
 * presence holds no credential, names a provider this build does not know,
 * or the provider refused transiently (fails open: the linked directory
 * answers regardless). A DEAD credential is different: it flips the
 * presence, and the call that discovered it must say so rather than answer
 * "nobody matching" over a roster it could not read — the same message the
 * send path gives, so the model hears one story whichever tool found out.
 */
const fromProvider = async <T>(
  presence: Presence,
  ask: (provider: ChannelProvider, credentialsJson: string) => Promise<T>,
): Promise<T | null> => {
  if (!presence.credentials || !isChannelProviderId(presence.provider)) {
    return null;
  }
  try {
    return await ask(
      channelProvider(presence.provider),
      await getCrypto().decrypt(presence.credentials),
    );
  } catch (err) {
    if (await noteOutboundFailure(presence.id, err)) {
      const platform = channelProvider(presence.provider).displayName;
      throw new ServiceError(
        "UNPROCESSABLE",
        `Your ${platform} app was removed from the workspace, so this tool no longer works. It needs to be re-attached from your Channels page in the OneCLI dashboard before you can reach ${platform} again. Do not retry.`,
      );
    }
    return null;
  }
};
/**
 * People search over the connected tenant: the linked directory (verified
 * names) unioned with the workspace roster (unverified profile names).
 * Tenant-fenced: foreign team_id or is_stranger members never appear —
 * Slack Connect participants are not discoverable (v1 scope, same fence as
 * the reach lane).
 */
export const findPeople = async (
  agentId: string,
  query: string,
): Promise<RecipientCandidate[]> => {
  const presence = await presenceOf(agentId);
  if (!presence) return [];
  const normalized = searchKeyOf(query);
  if (!normalized) return [];

  const directory = await mentionDirectoryOf(presence.integrationId);
  const linkedByExternalId = new Map<string, string>();
  const results: (RecipientCandidate & { rank: number })[] = [];

  for (const entries of directory.values()) {
    for (const entry of entries) {
      linkedByExternalId.set(entry.externalUserId, entry.displayName);
      const rank = rankOf(searchKeyOf(entry.displayName), normalized);
      if (rank < 3) {
        results.push({
          kind: "person",
          ref: entry.externalUserId,
          name: entry.displayName,
          verified: true,
          rank,
        });
      }
    }
  }

  // The provider's roster (tenant-fenced and self-excluded by the provider,
  // which alone knows how its tenant and its own bot user read); ranking,
  // the verified-name precedence and the cap are ours. Other bots are APPS
  // — labeled candidates, not silent holes (the "Shuf" lesson: an empty
  // answer makes the model invent wrong reasons).
  const members = await fromProvider(presence, (provider, credentialsJson) =>
    provider.listMembers({
      credentialsJson,
      tenantId: presence.integration.externalId,
      selfIdentityRef: presence.identityRef,
    }),
  );
  for (const member of members ?? []) {
    if (linkedByExternalId.has(member.ref)) continue; // already verified
    const name = cleanLabel(member.name);
    if (!name) continue;
    const rank = rankOf(searchKeyOf(name), normalized);
    if (rank < 3) {
      results.push({
        kind: member.isApp ? "app" : "person",
        ref: member.ref,
        name,
        verified: false,
        rank,
      });
    }
  }

  return results
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        // Humans are the common intent: at equal rank a person outranks an
        // app, and within persons the platform-verified name wins.
        Number(a.kind === "app") - Number(b.kind === "app") ||
        Number(b.verified) - Number(a.verified),
    )
    .slice(0, MAX_RESULTS)
    .map(({ rank, ...candidate }) => (void rank, candidate));
};

/** Channel search — read-only discovery ("does #general exist, am I in
 * it?"). Sees what channels:read/groups:read grant: public channels plus
 * private ones the bot joined. Never a send power. */
export const findChannels = async (
  agentId: string,
  query: string,
): Promise<ChannelCandidate[]> => {
  const presence = await presenceOf(agentId);
  if (!presence) return [];
  const normalized = searchKeyOf(query.replace(/^#/, ""));
  if (!normalized) return [];

  const results: (ChannelCandidate & { rank: number })[] = [];
  const channels = await fromProvider(presence, (provider, credentialsJson) =>
    provider.listChannels({ credentialsJson }),
  );
  for (const channel of channels ?? []) {
    const name = cleanLabel(channel.name);
    if (!name) continue;
    const rank = rankOf(searchKeyOf(name), normalized);
    if (rank < 3) {
      results.push({
        kind: "channel",
        ref: channel.ref,
        name: `#${name}`,
        member: channel.member,
        private: channel.private,
        rank,
      });
    }
  }

  return results
    .sort((a, b) => a.rank - b.rank || Number(b.member) - Number(a.member))
    .slice(0, MAX_RESULTS)
    .map(({ rank, ...candidate }) => (void rank, candidate));
};

/**
 * Record a pick: "in this conversation, @[name] means this provider user".
 * Upsert (last pick wins) — re-finding the same name repoints it, and the
 * unique key keeps one anchor per name per conversation.
 */
export const anchorRecipient = async (input: {
  conversationId: string;
  name: string;
  externalUserId: string;
  /** What the pick pointed at — frozen on the anchor (pick-time truth).
   * Defaults to "person" for the pre-4e call shape. */
  kind?: "person" | "app" | "channel";
}): Promise<void> => {
  const name = normalizeMentionName(input.name);
  const displayName = cleanLabel(input.name);
  if (!name || !displayName) return;
  const kind = input.kind ?? "person";
  await db.mentionAnchor.upsert({
    where: {
      conversationId_name: { conversationId: input.conversationId, name },
    },
    create: {
      conversationId: input.conversationId,
      name,
      externalUserId: input.externalUserId,
      displayName,
      kind,
    },
    update: { externalUserId: input.externalUserId, displayName, kind },
  });
};
