"use client";

import type { ReactNode } from "react";
import { Bot, Hash, Users, UsersRound } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
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
import { ContactRow } from "./contact-row";
import { ContactRowFrame } from "./contact-row-frame";
import { PeerRow } from "./peer-row";
import { PersonReachRow } from "./person-reach-row";
import { SpaceReachRow } from "./space-reach-row";

/**
 * The agent's Contacts section (PR 5b): WHO it talks with, by kind, each
 * row carrying its standing. Four groups answer four different questions:
 *
 * - People: who may talk to the agent one-on-one. Workspace members always
 *   can (no control - that is what membership is); a person who wrote from
 *   a channel provider with no OneCLI account has a reach row (moved here
 *   from the provider card), and a person the agent messaged on its own has
 *   a contact row.
 * - Channels: the rooms the agent is in and who it answers there (the space
 *   reach rows, moved here), plus channels it messaged on its own.
 * - Agents: the other agents it may message, with this side's policy and
 *   the pair conversation once they have talked.
 * - Apps: the provider-side apps it messaged on its own.
 *
 * Every row is the same shape (`ContactRowFrame`): who, their standing,
 * one `…`. Approvals are NOT here: pending asks live in the bell, the one
 * inbox, and a row that is waiting says so and points there.
 *
 * Rows come from the existing queries (channels view, contacts, peers):
 * the section composes, it does not own data. Loading renders a skeleton,
 * never an empty group (the availability rule).
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
  const personContacts = rows.filter((c) => c.kind === "person");
  const channelContacts = rows.filter((c) => c.kind === "channel");
  const appContacts = rows.filter((c) => c.kind === "app");

  return (
    <div className="space-y-8">
      <Group
        icon={Users}
        title="People"
        description="Who can message the agent directly."
        rows={[
          // Membership is the permission: nothing to change, nothing to
          // remove, so the frame renders no menu and keeps the column.
          <ContactRowFrame
            key="members"
            label="Workspace members"
            status={
              <Badge
                variant="secondary"
                className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              >
                Allowed
              </Badge>
            }
          />,
          ...live.flatMap((presence) =>
            (presence.people ?? []).map((person) => (
              <PersonReachRow
                key={`${presence.provider}:${person.externalRef}`}
                agentId={agent.id}
                provider={presence.provider}
                person={person}
              />
            )),
          ),
          ...personContacts.map((contact) => (
            <ContactRow key={contact.id} agentId={agent.id} contact={contact} />
          )),
        ]}
      />

      <Group
        icon={Hash}
        title="Channels"
        description="Where the agent is, and who it answers there."
        empty="Mention the agent in a channel to add it here."
        rows={[
          ...live.flatMap((presence) =>
            (presence.spaces ?? []).map((space) => (
              <SpaceReachRow
                key={`${presence.provider}:${space.externalRef}`}
                agentId={agent.id}
                provider={presence.provider}
                space={space}
              />
            )),
          ),
          ...channelContacts.map((contact) => (
            <ContactRow key={contact.id} agentId={agent.id} contact={contact} />
          )),
        ]}
      />

      <Group
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

      <Group
        icon={Bot}
        title="Apps"
        description="Apps the agent has messaged."
        empty="None yet."
        rows={appContacts.map((contact) => (
          <ContactRow key={contact.id} agentId={agent.id} contact={contact} />
        ))}
      />
    </div>
  );
};

/** One kind's group: heading, one-line description, the rows or the empty
 *  line. `rows` is an explicit array so "empty" is a count, not a guess. */
const Group = ({
  icon: Icon,
  title,
  description,
  empty,
  rows,
}: {
  icon: typeof Users;
  title: string;
  description: string;
  /** Shown when the group has no rows. */
  empty?: string;
  rows: ReactNode[];
}) => (
  <section className="space-y-2">
    <div className="flex items-center gap-2">
      <Icon className="text-muted-foreground size-4" aria-hidden />
      <h2 className="text-sm font-medium">{title}</h2>
    </div>
    <p className="text-muted-foreground text-xs text-pretty">{description}</p>
    {rows.length === 0 ? (
      empty !== undefined && (
        <p className="text-muted-foreground rounded-md border border-dashed px-3 py-3 text-sm">
          {empty}
        </p>
      )
    ) : (
      <div className="divide-y rounded-md border px-3">{rows}</div>
    )}
  </section>
);
