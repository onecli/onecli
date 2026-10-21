"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { channels } from "@/lib/api";
import type {
  AgentChannelPresence,
  AgentChannelsView,
  AgentContact,
  AgentPeer,
  ChannelPersonReach,
  ChannelListenMode,
  ChannelProvider,
  ChannelReachState,
  ChannelSpaceReach,
  ChannelTransport,
  CompletePresenceInput,
} from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";
import {
  listItem,
  patchItem,
  throughField,
  type ItemLens,
} from "@/lib/api/optimistic";
import { useOptimisticMutation } from "@/hooks/use-optimistic-mutation";

// Channel mutations are headless (the use-app-config convention): the callers
// (the agent Channels section, the org settings cards) own the toasts. No
// `invalidateGatewayCache()` anywhere — deliberate: the gateway reads none of
// the channel tables (its approvals key is matched by raw string, not cached
// config), so a flush would be pure noise.
//
// The Contacts choosers (who the agent answers, what it hears, whom it may
// message, a peer's standing) are optimistic: the badge shows the new choice
// on click and a failure puts it back with the reason. Their writes answer
// with no row, so the settle refetch is what confirms them.

/** The one payload the agent's Channels section renders: presences + posture
 * + org-integration availability + adapter liveness. */
export const useAgentChannels = (agentId: string) =>
  useQuery({
    queryKey: queryKeys.channels.agent(agentId),
    queryFn: () => channels.agentView(agentId),
    // Callers outside the Channels section (the chat's greeting card) read
    // this defensively, so an absent id must disable the query rather than
    // fetch a doomed path.
    enabled: agentId.length > 0,
    // This page's truth changes in ANOTHER tab (Slack's install/uninstall
    // pages) and the round-trip is often under the global 30s staleTime,
    // which would swallow the focus refetch. Always refetch on return.
    staleTime: 0,
  });

/** The paste floor's step 0 — fetched only while the floor is on screen.
 * Keyed by the chosen transport: the manifest bakes it in. */
export const useChannelManifest = (
  agentId: string,
  provider: ChannelProvider,
  enabled: boolean,
  transport?: ChannelTransport,
) =>
  useQuery({
    queryKey: queryKeys.channels.manifest(agentId, provider, transport),
    queryFn: () => channels.manifest(agentId, provider, transport),
    enabled,
  });

/** The guided arm: create the provider app from the org credential. Safe to
 * re-run on a pending presence — the server returns fresh URLs (resume). */
export const useAttachChannel = (
  agentId: string,
  provider: ChannelProvider,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { transport?: ChannelTransport } | undefined) =>
      channels.attach(agentId, provider, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
      // The agent lists carry the attached channels (the connected marks,
      // the delete confirmation) — root(), so the sweep reaches the
      // sidebar's for-workspace key too.
      qc.invalidateQueries({ queryKey: queryKeys.agents.root() });
    },
  });
};

/** The pasted-tokens completion door (socket arm + the whole paste floor). */
export const useCompleteChannel = (
  agentId: string,
  provider: ChannelProvider,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CompletePresenceInput) =>
      channels.complete(agentId, provider, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
      // The agent lists carry the attached channels (the connected marks,
      // the delete confirmation) — root(), so the sweep reaches the
      // sidebar's for-workspace key too.
      qc.invalidateQueries({ queryKey: queryKeys.agents.root() });
    },
  });
};

export const useDetachChannel = (
  agentId: string,
  provider: ChannelProvider,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (options: { deleteRemote: boolean }) =>
      channels.detach(agentId, provider, options),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
      // The agent lists carry the attached channels (the connected marks,
      // the delete confirmation) — root(), so the sweep reaches the
      // sidebar's for-workspace key too.
      qc.invalidateQueries({ queryKey: queryKeys.agents.root() });
    },
  });
};

/** The app card's "Sync image" button: pull the app's current icon from
 * the provider NOW. Headless like the other channel mutations; the card owns
 * the toast. Always refetches the card and every agent read (lists and the
 * detail), so a changed icon shows on the card, header and sidebar. */
export const useSyncAgentIcon = (
  agentId: string,
  provider: ChannelProvider,
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => channels.syncIcon(agentId, provider),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: queryKeys.channels.agent(agentId) });
      qc.invalidateQueries({ queryKey: queryKeys.agents.root() });
    },
  });
};

/** One reach row (a channel's or a person's) inside one presence of the
 * agent's channels view. */
const reachRow = <K extends "spaces" | "people">(
  provider: ChannelProvider,
  field: K,
  externalRef: string,
): ItemLens<
  AgentChannelsView,
  NonNullable<AgentChannelPresence[K]>[number]
> => {
  type Row = NonNullable<AgentChannelPresence[K]>[number];
  const rows = listItem<Row>((r) => r.externalRef === externalRef);
  const presence = listItem<AgentChannelPresence>(
    (p) => p.provider === provider,
  );
  return throughField<AgentChannelsView, "presences", Row>("presences", {
    get: (presences) => {
      const found = presence.get(presences);
      return found ? rows.get(found[field] ?? []) : undefined;
    },
    set: (presences, item, original) => {
      const found = presence.get(presences);
      if (!found) return presences;
      // The presence as it was, so a rolled-back dismiss returns to its row.
      const was = original && presence.get(original);
      const next = rows.set(
        found[field] ?? [],
        item,
        was?.[field] ?? undefined,
      );
      return presence.set(presences, { ...found, [field]: next });
    },
  });
};

const refreshChannels = (qc: QueryClient) =>
  qc.invalidateQueries({ queryKey: queryKeys.channels.all() });

const reachLabel = (
  qc: QueryClient,
  agentId: string,
  provider: ChannelProvider,
  field: "spaces" | "people",
  externalRef: string,
) => {
  const data = qc.getQueryData<AgentChannelsView>(
    queryKeys.channels.agent(agentId),
  );
  const row = data && reachRow(provider, field, externalRef).get(data);
  return row?.label ?? externalRef;
};

/** Settle one channel (channels view `spaces` rows): anyone in it, OneCLI
 * users only, or blocked entirely. Instant. */
export const useSetReachState = (agentId: string, provider: ChannelProvider) =>
  useOptimisticMutation<
    { kind: string },
    { externalRef: string; state: Exclude<ChannelReachState, "pending"> }
  >({
    family: `channels:${agentId}`,
    itemKey: ({ externalRef }) => `reach:${agentId}:space:${externalRef}`,
    write: ({ externalRef, state }) =>
      channels.setReachState(agentId, provider, externalRef, state),
    apply: (qc, { externalRef, state }) =>
      patchItem(
        qc,
        queryKeys.channels.agent(agentId),
        reachRow(provider, "spaces", externalRef),
        (row: ChannelSpaceReach | undefined) => (row ? { ...row, state } : row),
      ),
    refresh: refreshChannels,
    failure: (qc, { externalRef }) =>
      `Couldn't change who answers in ${reachLabel(qc, agentId, provider, "spaces", externalRef)}`,
  });

/** Promote (or demote) the agent in one channel: what it hears there.
 * Instant. */
export const useSetSpaceListen = (agentId: string, provider: ChannelProvider) =>
  useOptimisticMutation<
    { listen: ChannelListenMode },
    { externalRef: string; listen: ChannelListenMode }
  >({
    family: `channels:${agentId}`,
    itemKey: ({ externalRef }) => `listen:${agentId}:${externalRef}`,
    write: ({ externalRef, listen }) =>
      channels.setSpaceListen(agentId, provider, externalRef, listen),
    apply: (qc, { externalRef, listen }) =>
      patchItem(
        qc,
        queryKeys.channels.agent(agentId),
        reachRow(provider, "spaces", externalRef),
        (row: ChannelSpaceReach | undefined) =>
          row ? { ...row, listen } : row,
      ),
    refresh: refreshChannels,
    failure: (qc, { externalRef }) =>
      `Couldn't change what the agent hears in ${reachLabel(qc, agentId, provider, "spaces", externalRef)}`,
  });

/** Settle one PERSON (channels view `people` rows): allowed, or not.
 * Instant. */
export const useSetPersonReachState = (
  agentId: string,
  provider: ChannelProvider,
) =>
  useOptimisticMutation<
    { kind: string },
    { externalRef: string; state: "approved" | "blocked" }
  >({
    family: `channels:${agentId}`,
    itemKey: ({ externalRef }) => `reach:${agentId}:person:${externalRef}`,
    write: ({ externalRef, state }) =>
      channels.setPersonReachState(agentId, provider, externalRef, state),
    apply: (qc, { externalRef, state }) =>
      patchItem(
        qc,
        queryKeys.channels.agent(agentId),
        reachRow(provider, "people", externalRef),
        (row: ChannelPersonReach | undefined) =>
          row ? { ...row, state } : row,
      ),
    refresh: refreshChannels,
    failure: (qc, { externalRef, state }) =>
      `Couldn't ${state === "approved" ? "allow" : "stop"} ${reachLabel(qc, agentId, provider, "people", externalRef)}`,
  });

/** DISMISS a person row - forget the decision; they re-knock if they write.
 * Instant: the row leaves on click and comes back if the server refuses. */
export const useDismissPersonReach = (
  agentId: string,
  provider: ChannelProvider,
) =>
  useOptimisticMutation<unknown, { externalRef: string }>({
    family: `channels:${agentId}`,
    itemKey: ({ externalRef }) => `reach:${agentId}:person:${externalRef}`,
    write: ({ externalRef }) =>
      channels.dismissPersonReach(agentId, provider, externalRef),
    apply: (qc, { externalRef }) =>
      patchItem(
        qc,
        queryKeys.channels.agent(agentId),
        reachRow(provider, "people", externalRef),
        () => undefined,
      ),
    refresh: refreshChannels,
    failure: (qc, { externalRef }) =>
      `Couldn't remove ${reachLabel(qc, agentId, provider, "people", externalRef)}`,
  });

/** DISMISS a channel row - forget it entirely; the next outside message
 * re-knocks and a re-mention re-links the threads. Instant. */
export const useDismissReachRow = (
  agentId: string,
  provider: ChannelProvider,
) =>
  useOptimisticMutation<unknown, { externalRef: string }>({
    family: `channels:${agentId}`,
    itemKey: ({ externalRef }) => `reach:${agentId}:space:${externalRef}`,
    write: ({ externalRef }) =>
      channels.dismissReachRow(agentId, provider, externalRef),
    apply: (qc, { externalRef }) =>
      patchItem(
        qc,
        queryKeys.channels.agent(agentId),
        reachRow(provider, "spaces", externalRef),
        () => undefined,
      ),
    refresh: refreshChannels,
    failure: (qc, { externalRef }) =>
      `Couldn't remove ${reachLabel(qc, agentId, provider, "spaces", externalRef)}`,
  });

/** The agent's outbound address book — send_message's standing decisions. */
export const useAgentContacts = (agentId: string) =>
  useQuery({
    queryKey: queryKeys.channels.contacts(agentId),
    queryFn: () => channels.listContacts(agentId),
  });

const contactRow = (contactId: string) =>
  throughField<{ contacts: AgentContact[] }, "contacts", AgentContact>(
    "contacts",
    listItem((c) => c.id === contactId),
  );

const contactName = (qc: QueryClient, agentId: string, contactId: string) =>
  qc
    .getQueryData<{
      contacts: AgentContact[];
    }>(queryKeys.channels.contacts(agentId))
    ?.contacts.find((c) => c.id === contactId)?.displayName;

/** Flip one contact's policy (`ask` revokes the standing permission).
 * Instant. */
export const useSetContactPolicy = (agentId: string) =>
  useOptimisticMutation<
    { id: string; policy: string },
    { contactId: string; policy: "ask" | "allow" | "blocked" }
  >({
    family: `contacts:${agentId}`,
    itemKey: ({ contactId }) => `contact:${agentId}:${contactId}`,
    write: ({ contactId, policy }) =>
      channels.setContactPolicy(agentId, contactId, policy),
    apply: (qc, { contactId, policy }) =>
      patchItem(
        qc,
        queryKeys.channels.contacts(agentId),
        contactRow(contactId),
        (c) => (c ? { ...c, policy } : c),
      ),
    refresh: (qc) =>
      qc.invalidateQueries({ queryKey: queryKeys.channels.contacts(agentId) }),
    failure: (qc, { contactId }) =>
      `Couldn't change whether the agent may message ${contactName(qc, agentId, contactId) ?? "this contact"}`,
  });

/** Remove a contact row entirely — back to ask-by-default. Instant: the row
 * leaves on click and comes back if the server refuses. Callers say the
 * confirmation (they know the wording the row needs). */
export const useDeleteContact = (agentId: string) =>
  useOptimisticMutation<void, string>({
    family: `contacts:${agentId}`,
    itemKey: (contactId) => `contact:${agentId}:${contactId}`,
    write: (contactId) => channels.deleteContact(agentId, contactId),
    apply: (qc, contactId) =>
      patchItem(
        qc,
        queryKeys.channels.contacts(agentId),
        contactRow(contactId),
        () => undefined,
      ),
    refresh: (qc) =>
      qc.invalidateQueries({ queryKey: queryKeys.channels.contacts(agentId) }),
    failure: (qc, contactId) =>
      `Couldn't remove ${contactName(qc, agentId, contactId) ?? "the contact"}`,
  });

/** The agent's peers — other hosted agents and both sides' standing. */
export const useAgentPeers = (agentId: string) =>
  useQuery({
    queryKey: queryKeys.channels.peers(agentId),
    queryFn: () => channels.listPeers(agentId),
  });

const peerRow = (peerAgentId: string) =>
  throughField<{ peers: AgentPeer[] }, "peers", AgentPeer>(
    "peers",
    listItem((p) => p.agentId === peerAgentId),
  );

const refreshPeers = (agentId: string) => (qc: QueryClient) =>
  qc.invalidateQueries({ queryKey: queryKeys.channels.peers(agentId) });

const peerName = (qc: QueryClient, agentId: string, peerAgentId: string) =>
  qc
    .getQueryData<{ peers: AgentPeer[] }>(queryKeys.channels.peers(agentId))
    ?.peers.find((p) => p.agentId === peerAgentId)?.name ?? "this agent";

/** Set THIS agent's side of a pair (`ask` revokes the standing permission).
 * Instant. */
export const useSetPeerPolicy = (agentId: string) =>
  useOptimisticMutation<
    { id: string; policy: string },
    { peerAgentId: string; policy: "ask" | "allow" | "blocked" }
  >({
    family: `peers:${agentId}`,
    itemKey: ({ peerAgentId }) => `peer:${agentId}:${peerAgentId}`,
    write: ({ peerAgentId, policy }) =>
      channels.setPeerPolicy(agentId, peerAgentId, policy),
    apply: (qc, { peerAgentId, policy }) =>
      patchItem(
        qc,
        queryKeys.channels.peers(agentId),
        peerRow(peerAgentId),
        (p) => (p ? { ...p, myPolicy: policy } : p),
      ),
    refresh: refreshPeers(agentId),
    failure: (qc, { peerAgentId }) =>
      `Couldn't change your standing with ${peerName(qc, agentId, peerAgentId)}`,
  });

/** Continue THIS agent's paused pair conversation (the peer row's Resume). */
export const useResumePeer = (agentId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (peerAgentId: string) =>
      channels.resumePeer(agentId, peerAgentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.channels.peers(agentId) });
    },
  });
};

/** Forget a pair from THIS agent's side (policy, conversation, pending asks).
 * Instant: the row reads pristine on click (this side back to ask, no
 * conversation, no pause); the refetch settles the rest, including a
 * foreign peer leaving the list. A failure puts the pair back. */
export const useForgetPeer = (agentId: string) =>
  useOptimisticMutation<void, string>({
    family: `peers:${agentId}`,
    itemKey: (peerAgentId) => `peer:${agentId}:${peerAgentId}`,
    write: (peerAgentId) => channels.forgetPeer(agentId, peerAgentId),
    apply: (qc, peerAgentId) =>
      patchItem(
        qc,
        queryKeys.channels.peers(agentId),
        peerRow(peerAgentId),
        (p): AgentPeer | undefined =>
          p && {
            ...p,
            myPolicy: "ask",
            conversationId: null,
            paused: false,
            taskOpen: false,
          },
      ),
    refresh: refreshPeers(agentId),
    failure: (qc, peerAgentId) =>
      `Couldn't remove ${peerName(qc, agentId, peerAgentId)}`,
  });
