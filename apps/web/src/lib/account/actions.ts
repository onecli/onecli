"use server";

import { db } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";
import { activeMembershipWhere } from "@onecli/api/services/organization-service";
import { enforceSsoSession } from "@onecli/api/ee/sso/sso-enforcement";
import { normalizePlan, getPlanConfig } from "@onecli/api/ee/billing/plans";

const requireUser = async () => {
  const session = await getServerSession();
  if (!session) throw new Error("Not authenticated");
  const user = await db.user.findUnique({
    where: { externalAuthId: session.id },
    select: { id: true, email: true, name: true },
  });
  if (!user) throw new Error("User not found");
  // Server actions are POST endpoints any authenticated session can invoke —
  // mirror the /v1/auth/session "require SSO" enforcement here too (this file
  // reads org audit logs).
  const denial = await enforceSsoSession(session, user);
  if (denial) throw new Error(denial.error);
  return user;
};

export interface AccountPreferencesData {
  email: string;
  /**
   * Whether this account signs in with a password at all. A self-hosted user
   * who only ever used Google has no credential to change, and offering them
   * the form would mean offering an action that can only fail.
   */
  hasPassword: boolean;
}

export const getAccountPreferencesData =
  async (): Promise<AccountPreferencesData> => {
    const user = await requireUser();

    const credentialCount = await db.account.count({
      where: { userId: user.id, providerId: "credential" },
    });

    return {
      email: user.email,
      hasPassword: credentialCount > 0,
    };
  };

export interface AuditLogEntry {
  id: string;
  action: string;
  service: string;
  status: string;
  source: string;
  userEmail: string;
  workspaceId: string | null;
  workspaceName: string | null;
  organizationName: string | null;
  scope: "workspace" | "organization";
  metadata: unknown;
  createdAt: Date;
}

export const getAuditLogs = async (): Promise<AuditLogEntry[]> => {
  const user = await requireUser();

  const memberships = await db.organizationMember.findMany({
    where: { userId: user.id, ...activeMembershipWhere },
    select: { organization: { select: { subscriptionStatus: true } } },
  });

  const maxRetentionDays = memberships.reduce((max, m) => {
    const plan = normalizePlan(m.organization.subscriptionStatus);
    return Math.max(max, getPlanConfig(plan).limits.auditLogDays);
  }, 1);

  const retentionCutoff = new Date();
  retentionCutoff.setDate(retentionCutoff.getDate() - maxRetentionDays);

  const logs = await db.auditLog.findMany({
    where: {
      createdAt: { gte: retentionCutoff },
      OR: [
        {
          workspace: {
            organization: {
              members: {
                some: { userId: user.id, status: { not: "suspended" } },
              },
            },
          },
        },
        {
          organization: {
            members: {
              some: { userId: user.id, status: { not: "suspended" } },
            },
          },
        },
      ],
    },
    select: {
      id: true,
      workspaceId: true,
      action: true,
      service: true,
      status: true,
      source: true,
      userEmail: true,
      metadata: true,
      createdAt: true,
      workspace: { select: { name: true } },
      organization: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return logs.map((l) => ({
    id: l.id,
    action: l.action,
    service: l.service,
    status: l.status,
    source: l.source,
    userEmail: l.userEmail,
    workspaceId: l.workspaceId,
    workspaceName: l.workspace?.name ?? null,
    organizationName: l.organization?.name ?? null,
    scope: l.workspaceId ? ("workspace" as const) : ("organization" as const),
    metadata: l.metadata,
    createdAt: l.createdAt,
  }));
};
