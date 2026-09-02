import type { ResourceHooks } from "../../providers";
import {
  assertCanCreateAgent,
  assertCanCreateSecret,
} from "../services/quota-service";

export const eeResourceHooks: ResourceHooks = {
  beforeCreateAgent: async (organizationId) => {
    await assertCanCreateAgent(organizationId);
  },
  // Deliberately a wrapper, not a bare reference: this module now loads with
  // the providers barrel in every process, so the import must not be
  // dereferenced at module scope (partial vi.mock()s of quota-service and
  // import cycles would both break).
  beforeCreateSecret: async (organizationId) => {
    await assertCanCreateSecret(organizationId);
  },
};
