import { db } from "@onecli/db";
import { logger } from "../lib/logger";
import { LLM_PROVIDER_IDS } from "../llm/registry";
import {
  addDefaultGrants,
  type DefaultGrantRequest,
  type DefaultGrantResult,
} from "./grants-service";
import { auditAutoGrants, autoAttachScope } from "./llm-autoattach-service";

/**
 * "A new credential is on for every agent" — the workspace auto-attach.
 *
 * Product decision (2026-09-28): a connection or custom secret created IN A
 * WORKSPACE is attached to every agent of that workspace at creation, so it
 * works right away. The post-connect dialog then shows every toggle ON and is
 * where the user narrows it. The other order of events (2026-09-29): an agent
 * created later starts with every connection and custom secret the workspace
 * already has, so a new agent is as capable as the ones before it.
 *
 * This deliberately loosens the fail-closed default of the grants model for
 * workspace-created resources. The limits that keep it bounded:
 *  - **Workspace scope only.** Org-level connections/secrets reach every
 *    workspace in the org; granting them everywhere silently is a far wider
 *    blast radius, so they stay an explicit attach.
 *  - **Creation only, add-only.** A reconnect keeps whatever grants the
 *    connection has, and an existing grant (a customized one included) is
 *    never rewritten: nothing here re-grants or flattens what a user chose.
 *  - **Live resources, no LLM keys.** Disconnected connections are skipped;
 *    LLM keys follow `llm-autoattach-service`, which only fills an agent that
 *    has none (a second key would re-point the agent's provider).
 *  - **Uncustomized, whole-app grants.** Exactly what the dialog's toggle
 *    writes, so turning one off is the same single detach.
 *  - **Org policy still wins.** A grant is a workspace rule, and org rules stay
 *    a hard ceiling in the engine: an org block still blocks.
 *
 * Best-effort by contract: the resource is already created, and a convenience
 * grant must never turn that into a failed request. Every attach is ONE
 * transaction and ONE publish (`addDefaultGrants`), and is audited.
 */

const log = logger.child({ component: "workspace-autoattach" });

const NOTHING: DefaultGrantResult = { connections: [], secrets: [] };

const workspaceAgentIds = async (workspaceId: string): Promise<string[]> =>
  (
    await db.agent.findMany({ where: { workspaceId }, select: { id: true } })
  ).map((a) => a.id);

/** Resolve the request, write it and audit what was written. Never throws. */
const attach = async (
  workspaceId: string,
  userId: string | null,
  resolve: () => Promise<DefaultGrantRequest>,
): Promise<DefaultGrantResult> => {
  try {
    const scope = await autoAttachScope(workspaceId);
    if (!scope) return NOTHING;
    const written = await addDefaultGrants(scope, await resolve(), userId);
    const agentIds = new Set(
      [...written.connections, ...written.secrets].map((g) => g.agentId),
    );
    if (agentIds.size > 0) {
      await auditAutoGrants(scope, userId, "workspace-autoattach", {
        agentIds: [...agentIds],
        connectionIds: [
          ...new Set(written.connections.map((c) => c.connectionId)),
        ],
        secretIds: [...new Set(written.secrets.map((s) => s.secretId))],
      });
    }
    return written;
  } catch (err) {
    log.warn({ err, workspaceId }, "workspace auto-attach skipped");
    return NOTHING;
  }
};

/** A freshly CREATED workspace connection, to every agent of the workspace. */
export const attachNewConnectionToAllAgents = (
  workspaceId: string,
  connectionId: string,
  userId: string | null,
): Promise<DefaultGrantResult> =>
  attach(workspaceId, userId, async () => ({
    agentIds: await workspaceAgentIds(workspaceId),
    connectionIds: [connectionId],
    secretIds: [],
  }));

/** A freshly CREATED workspace custom secret, to every agent of the
 * workspace. An LLM key is refused by the writer (see the header). */
export const attachNewSecretToAllAgents = (
  workspaceId: string,
  secretId: string,
  userId: string | null,
): Promise<DefaultGrantResult> =>
  attach(workspaceId, userId, async () => ({
    agentIds: await workspaceAgentIds(workspaceId),
    connectionIds: [],
    secretIds: [secretId],
  }));

/** Every live WORKSPACE connection and custom secret, to a freshly CREATED
 * agent. */
export const attachWorkspaceResourcesToNewAgent = (
  workspaceId: string,
  agentId: string,
  userId: string | null,
): Promise<DefaultGrantResult> =>
  attach(workspaceId, userId, async () => {
    const [connections, secrets] = await Promise.all([
      db.appConnection.findMany({
        where: { workspaceId, scope: "workspace", status: "connected" },
        select: { id: true },
      }),
      db.secret.findMany({
        where: {
          workspaceId,
          scope: "workspace",
          type: { notIn: LLM_PROVIDER_IDS },
        },
        select: { id: true },
      }),
    ]);
    return {
      agentIds: [agentId],
      connectionIds: connections.map((c) => c.id),
      secretIds: secrets.map((s) => s.id),
    };
  });
