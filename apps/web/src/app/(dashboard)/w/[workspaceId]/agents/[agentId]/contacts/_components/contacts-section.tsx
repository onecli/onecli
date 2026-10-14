"use client";

import { Bot, Hash, Users, UsersRound } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Skeleton } from "@onecli/ui/components/skeleton";
import type { AgentChannelPresence } from "@/lib/api";
import {
  useAgentChannels,
  useAgentContacts,
  useAgentPeers,
} from "@/hooks/use-channels";
import { isPresenceConnected } from "@/lib/agents/channel-providers";
import { useAgentPageAgent } from "../../_components/agent-page-frame";
import { ContactGroup } from "./contact-group";
import { ContactRow } from "./contact-row";
import { DirectionHeader } from "./direction-header";
import { mergeChannels, mergePeople } from "./merge-contacts";
import { PeerRow } from "./peer-row";
import { directionHeadings, TwoWayRow } from "./two-way-row";

/**
 * The agent's Contacts section: WHO it talks with, by kind.
 *
 * Every person and channel is ONE row with BOTH directions side by side,
 * under labeled columns: do they get answers when they write to the agent
 * (inbound), and may the agent write to them on its own (outbound)? The
 * server keeps those as two records (a reach row on the presence, a
 * contact in the outbound address book); shown apart, the same human
 * appeared twice with two unlabeled badges. They merge on the provider id.
 *
 * - People: anyone outside the workspace who wrote to the agent, and anyone
 *   it messaged (members included). Workspace members always get answers
 *   (membership is the permission), so that is a sentence, not a row with
 *   a fake setting.
 * - Channels: the rooms the agent is in, or posted to.
 * - Agents: the other agents it may message (both sides must allow).
 * - Apps: provider-side apps it messaged (outbound only).
 *
 * Approvals are NOT here: pending asks live in the bell, the one inbox,
 * and a cell that is waiting says so. Loading renders a skeleton, never an
 * empty group.
 */
export const ContactsSection = () => {
  const agent = useAgentPageAgent();
  const channels = useAgentChannels(agent.id);
  const contacts = useAgentContacts(agent.id);
  const peers = useAgentPeers(agent.id);

  if (channels.isPending || contacts.isPending || peers.isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (channels.isError || contacts.isError || peers.isError) {
    const retry = () => {
      void channels.refetch();
      void contacts.refetch();
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
  const rows = contacts.data.contacts;
  const people = mergePeople(live, rows);
  const rooms = mergeChannels(live, rows);
  const appContacts = rows.filter((c) => c.kind === "app");
  const personHeadings = directionHeadings("person", agent.name);
  const channelHeadings = directionHeadings("channel", agent.name);

  return (
    <div className="space-y-8">
      <ContactGroup
        icon={Users}
        title="People"
        description={
          <>
            Members of this workspace can always message{" "}
            <span translate="no">{agent.name}</span>. Here: who else may message
            it, and whom it may message.
          </>
        }
        empty="No one yet."
        header={<DirectionHeader {...personHeadings} />}
        rows={people.map((entry) => (
          <TwoWayRow
            key={entry.key}
            kind="person"
            agentId={agent.id}
            agentName={agent.name}
            entry={entry}
          />
        ))}
      />

      <ContactGroup
        icon={Hash}
        title="Channels"
        description="Where the agent is, who it answers there, and where it may post on its own."
        empty="Mention the agent in a channel to add it here."
        header={<DirectionHeader {...channelHeadings} />}
        rows={rooms.map((entry) => (
          <TwoWayRow
            key={entry.key}
            kind="channel"
            agentId={agent.id}
            agentName={agent.name}
            entry={entry}
          />
        ))}
      />

      <ContactGroup
        icon={UsersRound}
        title="Agents"
        description="Other agents this one can message. Both sides must allow."
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

      <ContactGroup
        icon={Bot}
        title="Apps"
        description="Apps the agent has messaged."
        empty="None yet."
        rows={appContacts.map((contact) => (
          <ContactRow
            key={contact.id}
            agentId={agent.id}
            agentName={agent.name}
            contact={contact}
          />
        ))}
      />
    </div>
  );
};
