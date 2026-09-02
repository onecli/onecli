import { createEditionSlot } from "../edition-state";

export interface ResourceHooks {
  beforeCreateAgent(organizationId: string, workspaceId: string): Promise<void>;
  beforeCreateSecret(organizationId: string): Promise<void>;
}

const noopResourceHooks: ResourceHooks = {
  beforeCreateAgent: async () => {},
  beforeCreateSecret: async () => {},
};

// Edition default: cloud enforces plan quotas before agent/secret creation —
// injected by `ensureEditionDefaults()`, keeping the quota service (and its
// Redis client) out of client bundles; onprem has no quotas.
const slot = createEditionSlot<ResourceHooks>(
  "resourceHooks",
  noopResourceHooks,
);

/** Test seam — the uniform slot override (`null` resets to the edition default). */
export const initResourceHooks = (h: ResourceHooks | null) => slot.init(h);

/** Package-internal: the edition-defaults injector. Not exported from the barrel. */
export const setDefaultResourceHooks = (h: ResourceHooks) =>
  slot.setCloudDefault(h);

export const getResourceHooks = (): ResourceHooks => slot.get();
