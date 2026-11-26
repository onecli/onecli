import type { Prisma } from "@onecli/db";
import { createEditionSlot } from "../edition-state";

/**
 * A hosted-platform agent capability, as seen from the free control plane.
 * The shared paths that carry it (the runner poll, the preview login
 * handoff, the relay's activity beat, the platform tool dispatcher) call
 * this seam; the implementation is licensed hosted-platform code, injected
 * at server boot on the hosted deployment only. Absent (every self-host):
 * nothing is claimed, no ticket is minted, the tool refuses, and the
 * activity and sweep calls are no-ops.
 */
export interface AgentDesktop {
  /** Expire what ran out of time. Called from the runner poll's sweep. */
  sweep(): Promise<void>;
  /** Claim this runner's pending pushes inside the poll's transaction, as
   * finished wire items. `replicaId` fences to the caller's own copy. */
  claimPushes(
    tx: Prisma.TransactionClient,
    runnerId: string,
    replicaId: string | undefined,
  ): Promise<AgentDesktopPush[]>;
  /** A viewer's stream on one of this agent's hosts is alive. */
  markActivity(
    agentId: string,
    userId: string | null,
    role: "view" | "control",
  ): Promise<void>;
  /** A stream credential for a host this person may use now; refuses with
   * a ServiceError otherwise. */
  mintTicket(viewer: {
    userId: string;
    userEmail: string;
    host: string;
  }): Promise<{ ticket: string }>;
  /** The agent's tool call, raw arguments included (validated inside). */
  callTool(input: {
    agentId: string;
    args: unknown;
    originConversationId: string | null;
    originTurnId: string | null;
  }): Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;
}

export interface AgentDesktopPush {
  kind: "desktop.control";
  sandboxId: string;
  controlled: boolean;
  controllerName?: string;
}

const slot = createEditionSlot<AgentDesktop | null>("agentDesktop", null);

/** Test seam (`null` resets to the edition default). */
export const initAgentDesktop = (d: AgentDesktop | null) => slot.init(d);

/** Package-internal: the edition-defaults injector. */
export const setDefaultAgentDesktop = (d: AgentDesktop) =>
  slot.setCloudDefault(d);

export const getAgentDesktop = (): AgentDesktop | null => slot.get();
