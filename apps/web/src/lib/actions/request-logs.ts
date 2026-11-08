"use server";

import { resolveWorkspaceContext } from "@/lib/actions/resolve-user";
import { getRequestLogs } from "@onecli/api/services/request-log-service";
import {
  activityPageSchema,
  type ActivityPageParams,
} from "@onecli/api/validations/request-logs";

/** A server action is a public endpoint: its params are parsed, not trusted. */
export const getActivityPage = async (params: ActivityPageParams = {}) => {
  const { workspaceId, userId, organizationId } =
    await resolveWorkspaceContext();
  return getRequestLogs(workspaceId, activityPageSchema.parse(params), {
    userId,
    organizationId,
  });
};
