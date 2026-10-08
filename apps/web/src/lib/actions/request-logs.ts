"use server";

import { resolveWorkspaceContext } from "@/lib/actions/resolve-user";
import {
  getRecentRequestLogs,
  getRequestLogs,
} from "@onecli/api/services/request-log-service";
import {
  activityPageSchema,
  type ActivityPageParams,
} from "@onecli/api/validations/request-logs";

export const getRecentActivity = async () => {
  const { workspaceId, userId, organizationId } =
    await resolveWorkspaceContext();
  return getRecentRequestLogs(workspaceId, 5, { userId, organizationId });
};

/** A server action is a public endpoint: its params are parsed, not trusted. */
export const getActivityPage = async (params: ActivityPageParams = {}) => {
  const { workspaceId, userId, organizationId } =
    await resolveWorkspaceContext();
  return getRequestLogs(workspaceId, activityPageSchema.parse(params), {
    userId,
    organizationId,
  });
};
