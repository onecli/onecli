"use server";

import { resolveUser } from "@/lib/actions/resolve-user";
import {
  getRecentRequestLogs,
  getRequestLogs,
  type ActivityPageParams,
} from "@/lib/services/request-log-service";

export const getRecentActivity = async () => {
  const { projectId } = await resolveUser();
  return getRecentRequestLogs(projectId, 5);
};

export const getActivityPage = async (params: ActivityPageParams = {}) => {
  const { projectId } = await resolveUser();
  return getRequestLogs(projectId, params);
};
