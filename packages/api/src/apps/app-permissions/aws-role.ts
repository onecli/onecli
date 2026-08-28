import type { AppPermissionDefinition } from "./types";
import { awsPermissions } from "./aws";

export const awsRolePermissions: AppPermissionDefinition = {
  provider: "aws-role",
  groups: awsPermissions.groups,
};
