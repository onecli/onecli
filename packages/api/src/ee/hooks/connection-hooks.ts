import type { ConnectionHooks } from "../../providers";
import { assertCanCreateOAuthApp } from "../services/quota-service";

export const eeConnectionHooks: ConnectionHooks = {
  async beforeCreate(organizationId) {
    await assertCanCreateOAuthApp(organizationId);
  },
};
