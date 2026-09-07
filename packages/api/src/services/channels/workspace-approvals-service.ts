import { db } from "@onecli/db";
import { normalizeState } from "./agent-reach-service";

/**
 * The approvals bell's CHANNEL arm (4d): every channel decision waiting on a
 * human in one workspace — pending one-shot action approvals and pending
 * reach asks — as one age-sorted list. The bell is the ONE decide surface
 * for these (the channels page keeps settled-state settings only), so this
 * listing carries everything a row and its decide dialog need; deciding
 * itself stays on the existing per-agent doors.
 *
 * Workspace-fenced at the query, both arms — a foreign workspace reads [].
 */

export interface PendingActionApprovalItem {
  kind: "action";
  id: string;
  agentId: string;
  agentName: string;
  summary: string;
  /** ISO timestamps. */
  createdAt: string;
  expiresAt: string;
}

export interface PendingReachAskItem {
  kind: "reach";
  id: string;
  agentId: string;
  agentName: string;
  provider: string;
  /** "space" = a channel (three-way decision); "external_user" = a person
   * (two-way). */
  subjectKind: "space" | "external_user";
  /** Display label captured at ask time ("#general", a person's name) —
   * may be null on old rows; the ref is the fallback the UI shows. */
  subjectLabel: string | null;
  /** The decide door's address (PUT reach/:externalRef). */
  externalRef: string;
  /** ISO timestamp. */
  createdAt: string;
}

export type PendingChannelApprovalItem =
  | PendingActionApprovalItem
  | PendingReachAskItem;

/** Oldest first: the longest-waiting ask is the one to surface. */
export const listWorkspacePendingChannelApprovals = async (
  workspaceId: string,
): Promise<PendingChannelApprovalItem[]> => {
  const [actions, asks] = await Promise.all([
    db.actionApproval.findMany({
      where: {
        status: "pending",
        expiresAt: { gt: new Date() },
        agent: { workspaceId },
      },
      select: {
        id: true,
        agentId: true,
        summary: true,
        createdAt: true,
        expiresAt: true,
        agent: { select: { name: true } },
      },
    }),
    db.agentReachGrant.findMany({
      where: { state: "pending", agent: { workspaceId } },
      select: {
        id: true,
        agentId: true,
        provider: true,
        subjectKind: true,
        subjectLabel: true,
        externalRef: true,
        state: true,
        createdAt: true,
        agent: { select: { name: true } },
      },
    }),
  ]);

  const items: PendingChannelApprovalItem[] = [
    ...actions.map(
      (a): PendingActionApprovalItem => ({
        kind: "action",
        id: a.id,
        agentId: a.agentId,
        agentName: a.agent.name,
        summary: a.summary,
        createdAt: a.createdAt.toISOString(),
        expiresAt: a.expiresAt.toISOString(),
      }),
    ),
    ...asks
      // A row in a non-pending normalized state (legacy spellings) never
      // reaches the bell even if the raw column says otherwise.
      .filter((g) => normalizeState(g.state ?? "pending") === "pending")
      .map(
        (g): PendingReachAskItem => ({
          kind: "reach",
          id: g.id,
          agentId: g.agentId,
          agentName: g.agent.name,
          provider: g.provider,
          subjectKind:
            g.subjectKind === "external_user" ? "external_user" : "space",
          subjectLabel: g.subjectLabel,
          externalRef: g.externalRef,
          createdAt: g.createdAt.toISOString(),
        }),
      ),
  ];

  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
};
