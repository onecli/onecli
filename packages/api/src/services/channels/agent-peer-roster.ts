import { db } from "@onecli/db";
import { MAX_AGENT_PEERS, type AgentPeerWire } from "@onecli/agent-protocol";
import { cleanLabel } from "../../lib/format";
import {
  findOpenTask,
  findOpenTaskForHome,
  homeTaskContext,
  ownerTaskContext,
  peerTaskContext,
} from "./peer-task-service";

/**
 * The peer ROSTER (PR 5b): the other hosted agents this one may address by
 * name. A pure read, in its own module on purpose: the dispatch and home
 * sync composers (`sandbox-service`, `home-sync-service`) need only this,
 * and importing the full link service from there would pull its
 * import-time handler registration into the channel graph's import cycle
 * (`agent-channel-service -> home-sync-service -> … -> action-approval-
 * service`), where the registry is not yet built. Same split as
 * `channelPresencesForRender` beside the presence service.
 */

/** Same workspace, hosted, never the agent itself. Name order. */
export const peerRoster = async (
  agentId: string,
  workspaceId: string,
): Promise<{ id: string; name: string }[]> =>
  db.agent.findMany({
    where: { workspaceId, kind: "hosted", NOT: { id: agentId } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

/**
 * The roster as the supervisor's `agents` capability receives it (display
 * names only, cleaned, capped by the wire brace) - composed at dispatch and
 * on every home sync, the `channelPresencesForRender` pattern.
 */
export const peersForRender = async (
  agentId: string,
): Promise<AgentPeerWire[]> => {
  const me = await db.agent.findUnique({
    where: { id: agentId },
    select: { workspaceId: true },
  });
  if (!me) return [];
  const roster = await peerRoster(agentId, me.workspaceId);
  return roster
    .map((peer) => ({ name: cleanLabel(peer.name) }))
    .filter((peer) => peer.name.length > 0)
    .slice(0, MAX_AGENT_PEERS);
};

/**
 * The standing context for a turn on a PAIR conversation (PR 5b) - the twin
 * of the channel lane's "This is a direct conversation with …": who is on
 * the other end and how to answer - plus, while a PEER TASK is open on the
 * pair, the task block for whichever side this agent is (the owner hears
 * the person's ask, its budget, and the one way out; the peer hears that a
 * person is behind the questions and how many replies it has). In a
 * PERSON's conversation, the standing line while its task is open. Null
 * for every other conversation. Says the peer's cleaned name only, never
 * anything the peer wrote (that is the turn's message, data with
 * provenance); the person's words appear only on the owner's side.
 */
export const buildPeerContext = async (
  conversationId: string,
): Promise<string | null> => {
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { agentId: true, source: true, externalRef: true },
  });
  if (!conversation) return null;
  if (conversation.source !== "agent") {
    return buildHomeTaskContext(conversationId);
  }
  if (!conversation.externalRef) return null;
  const [peer, task] = await Promise.all([
    db.agent.findUnique({
      where: { id: conversation.externalRef },
      select: { name: true },
    }),
    findOpenTask(conversation.agentId, conversation.externalRef),
  ]);
  const name = peer ? cleanLabel(peer.name) : "";
  if (!name) return null;
  const standing = `This is your conversation with ${name}, another OneCLI agent. Messages here prefixed "${name} (agent):" are from it. To answer, call message_agent with to: "${name}"; plain text you write here is not delivered to it.`;
  if (!task) return standing;
  if (task.agentId === conversation.agentId) {
    return `${standing}\n\n${ownerTaskContext(task, name)}`;
  }
  return `${standing}\n\n${peerTaskContext(task, name)}`;
};

/**
 * The standing line in a PERSON's conversation while a task opened from it
 * is running: the model that promised "I'll report back" is reminded where
 * the answers are and that the report lands here by itself.
 */
const buildHomeTaskContext = async (
  homeConversationId: string,
): Promise<string | null> => {
  const task = await findOpenTaskForHome(homeConversationId);
  if (!task) return null;
  const peer = await db.agent.findUnique({
    where: { id: task.peerAgentId },
    select: { name: true },
  });
  const name = peer ? cleanLabel(peer.name) : "";
  if (!name) return null;
  return homeTaskContext(task, name);
};
