"use client";

import { Hash, Users, UsersRound } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Skeleton } from "@onecli/ui/components/skeleton";
import type { AgentChannelPresence } from "@/lib/api";
import { useAgentChannels, useAgentPeers } from "@/hooks/use-channels";
import { isPresenceConnected } from "@/lib/agents/channel-providers";
import { useAgentPageAgent } from "../../_components/agent-page-frame";
import { EMPTY_ACT_AS_YOU, type ActAsYouSlot } from "./act-as-you-slot";
import { ContactGroup } from "./contact-group";
import { ContactRow } from "./contact-row";
import { mergeChannels, mergePeople, nameOf } from "./merge-contacts";
import { PeerRow } from "./peer-row";

export interface ContactsListProps {
  /** What "acts as you" adds (licensed); default: nothing. */
  actAsYou?: ActAsYouSlot;
}

/**
 * The agent's Contacts: WHO it talks with, by kind. Every row is ONE
 * setting (Always allow / Never). Entitled, the people and channel groups
 * become a table with "Reads as you" / "Writes as you" columns (what it may
 * do there with a person's own Slack), and shared conversations no row
 * matches get their own rows. The Agents group never has those columns.
 *
 * - Direct messages: the workspace owners (first, fixed on Always allow),
 *   anyone who DM'd the agent, and anyone it messaged. Their one setting
 *   decides both their DMs and the agent's messages to them. A workspace
 *   member needs no row to be answered; Never on their row silences them.
 * - Channels: the rooms the agent is in. Always allow means it replies there
 *   (to mentions or every message) and may post there.
 * - Agents: the other agents it may message (both sides must allow).
 *
 * Approvals are NOT here: pending asks live in the bell, the one inbox,
 * and a row that is waiting says so. Loading renders a skeleton, never an
 * empty group.
 */
export const ContactsList = ({
  actAsYou = EMPTY_ACT_AS_YOU,
}: ContactsListProps) => {
  const agent = useAgentPageAgent();
  const channels = useAgentChannels(agent.id);
  const peers = useAgentPeers(agent.id);

  if (channels.isPending || peers.isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (channels.isError || peers.isError) {
    const retry = () => {
      void channels.refetch();
      void peers.refetch();
    };
    return (
      <div className="space-y-3">
        <p className="text-muted-foreground text-sm">
          The contacts didn&apos;t load.
        </p>
        <Button variant="outline" size="sm" onClick={retry}>
          Try again
        </Button>
      </div>
    );
  }

  // Reach rows live on LIVE presences only: a removed app's rows are moot
  // and its card already says so.
  const live: AgentChannelPresence[] =
    channels.data.presences.filter(isPresenceConnected);
  const people = mergePeople(live);
  const rooms = mergeChannels(live);
  const personRows = [
    ...people.map((entry) => (
      <ContactRow
        key={entry.key}
        kind="person"
        agentId={agent.id}
        agentName={agent.name}
        entry={entry}
        extras={actAsYou.forRow("people", entry.key, nameOf(entry))}
      />
    )),
    ...actAsYou.standaloneRows(
      "people",
      people.map((e) => e.key),
    ),
  ];
  const channelRows = [
    ...rooms.map((entry) => (
      <ContactRow
        key={entry.key}
        kind="channel"
        agentId={agent.id}
        agentName={agent.name}
        entry={entry}
        extras={actAsYou.forRow("channels", entry.key, nameOf(entry))}
      />
    )),
    ...actAsYou.standaloneRows(
      "channels",
      rooms.map((e) => e.key),
    ),
  ];

  return (
    <div className="space-y-8">
      {actAsYou.header}
      <ContactGroup
        icon={Users}
        title="Direct messages"
        description={
          <>
            Who can DM <span translate="no">{agent.name}</span>, and who it can
            message.
          </>
        }
        empty="No one yet."
        rows={personRows}
        {...(actAsYou.columns && { asYouHeaderFor: agent.name })}
      />

      <ContactGroup
        icon={Hash}
        title="Channels"
        description={
          <>
            Where <span translate="no">{agent.name}</span> can reply and post.
          </>
        }
        empty="Mention the agent in a channel to add it here."
        rows={channelRows}
        {...(actAsYou.columns && { asYouHeaderFor: agent.name })}
      />

      <ContactGroup
        icon={UsersRound}
        title="Agents"
        description="Agents it can message. Both sides must allow."
        empty="No other agents yet."
        rows={peers.data.peers.map((peer) => (
          <PeerRow
            key={peer.agentId}
            agentId={agent.id}
            agentName={agent.name}
            peer={peer}
          />
        ))}
      />
    </div>
  );
};
