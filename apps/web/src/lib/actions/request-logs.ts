"use server";

import { resolveWorkspaceContext } from "@/lib/actions/resolve-user";
import {
  getRecentRequestLogs,
  getRequestLogs,
  type ActivityPageParams,
} from "@onecli/api/services/request-log-service";

export const getRecentActivity = async () => {
  const { workspaceId, userId, organizationId } =
    await resolveWorkspaceContext();
  return getRecentRequestLogs(workspaceId, 5, { userId, organizationId });
};

export const getActivityPage = async (params: ActivityPageParams = {}) => {
  const { workspaceId, userId, organizationId } =
    await resolveWorkspaceContext();
  return getRequestLogs(workspaceId, params, { userId, organizationId });
};
