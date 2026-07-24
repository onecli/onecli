"use server";

import { resolveProjectContext } from "@/lib/actions/resolve-user";
import {
  getRecentRequestLogs,
  getRequestLogs,
  type ActivityPageParams,
} from "@onecli/api/services/request-log-service";

export const getRecentActivity = async () => {
  const { projectId, userId, organizationId } = await resolveProjectContext();
  return getRecentRequestLogs(projectId, 5, { userId, organizationId });
};

export const getActivityPage = async (params: ActivityPageParams = {}) => {
  const { projectId, userId, organizationId } = await resolveProjectContext();
  return getRequestLogs(projectId, params, { userId, organizationId });
};
