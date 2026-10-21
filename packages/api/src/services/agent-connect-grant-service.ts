import { db } from "@onecli/db";
import { logger } from "../lib/logger";
import { ServiceError } from "./errors";
import { attachDefaultConnectionGrant } from "./grants-service";
import { auditAutoGrants, autoAttachScope } from "./llm-autoattach-service";

/**
 * "Connected from an agent, on for that agent", and for nobody else.
 *
 * The rule: a connection added in a WORKSPACE (its
 * Connections page) is on for no agent; the post-connect dialog is where the
 * user turns agents on, one by one. A connection added from an AGENT's context
 * (its Connections section, the chat's connect card, the connect link an agent
 * sends) is on for that agent from the start, and only for it. A new agent
 * likewise starts with no connection and no custom secret, only the LLM key it
 * needs to run (`llm-autoattach-service`).
 *
 * The connecting agent travels with the connect itself: the signed OAuth
 * state, the direct connect's body, the shared GitHub App connect's body. It
 * is checked against the caller's workspace BEFORE anything is stored
 * (`assertConnectingAgent`), so a foreign or unknown id is a 404, never a
 * connection left behind.
 *
 * The grant (`grantConnectingAgent`):
 *  - **Add-only.** An agent that already holds a stack for the connection (a
 *    narrowed one included) keeps it exactly as it is.
 *  - **Created or re-added, never reconnected.** A fresh connect that lands
 *    on an existing account (same name) turns it on for the connecting agent
 *    too. An explicit Reconnect of one connection only refreshes credentials,
 *    so callers never pass it here.
 *  - **The default attach** (`defaultConnectionGrant`): read tools allowed,
 *    write tools and requests outside the tool list needing approval, exactly
 *    what the attach toggle writes, so turning it off is the same detach.
 *  - **Org policy still wins.** A grant is a workspace rule, and org rules
 *    stay a hard ceiling in the engine.
 *
 * Best-effort by contract: the connection is already stored, and a convenience
 * grant must never turn that into a failed request. The grant is ONE
 * transaction and ONE publish, and it is audited.
 */

const log = logger.child({ component: "agent-connect-grant" });

/** Refuse a connecting agent that is not the workspace's own (404). Called
 * before the connection is stored, so a bad id never leaves one behind. */
export const assertConnectingAgent = async (
  workspaceId: string,
  agentId: string,
): Promise<void> => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: { id: true },
  });
  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found.");
};

/**
 * The one reading of "which agent did this connect start from", shared by
 * every connect door (OAuth authorize, direct connect, the GitHub App share)
 * so they can never answer the same input differently:
 *  - anything but a non-empty string names no agent (a workspace connect);
 *  - an ORGANIZATION connect naming one is a 400: agents live in
 *    workspaces, so there is nobody to turn it on for;
 *  - a workspace connect's agent must be the workspace's own (404).
 * Runs before anything is stored. Returns the fenced id, or undefined.
 */
export const resolveConnectingAgent = async (
  workspaceId: string | null | undefined,
  raw: unknown,
): Promise<string | undefined> => {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  if (!workspaceId) {
    throw new ServiceError(
      "BAD_REQUEST",
      "An organization connection has no agent to turn on.",
    );
  }
  await assertConnectingAgent(workspaceId, raw);
  return raw;
};

/** Turn a created (or re-added) workspace connection on for the agent the
 * connect started from. No agent = a workspace connect: nothing to grant.
 * Never throws (it logs and grants nothing instead). */
export const grantConnectingAgent = async (
  workspaceId: string,
  connectionId: string,
  agentId: string | undefined,
  userId: string | null,
): Promise<void> => {
  if (!agentId) return;
  try {
    const scope = await autoAttachScope(workspaceId);
    if (!scope) return;
    const { changed } = await attachDefaultConnectionGrant(
      scope,
      agentId,
      connectionId,
      userId,
    );
    if (changed) {
      await auditAutoGrants(scope, userId, "agent-connect", {
        agentId,
        connectionId,
      });
    }
  } catch (err) {
    log.warn(
      { err, workspaceId, agentId, connectionId },
      "connecting agent's grant skipped",
    );
  }
};
