"use server";

import { resolveProjectContext } from "@/lib/actions/resolve-user";
import {
  getRecentRequestLogs,
  getRequestLogs,
  type ActivityPageParams,
} from "@onecli/api/services/request-log-service";

export const getRecentActivity = async () => {
  const { projectId } = await resolveProjectContext();
  return getRecentRequestLogs(projectId, 5);
};

export const getActivityPage = async (params: ActivityPageParams = {}) => {
  const { projectId } = await resolveProjectContext();
  return getRequestLogs(projectId, params);
};
