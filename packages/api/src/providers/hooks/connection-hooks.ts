import { createEditionSlot } from "../edition-state";

export interface ConnectionHooks {
  beforeCreate(organizationId: string): Promise<void>;
}

const noopConnectionHooks: ConnectionHooks = {
  beforeCreate: async () => {},
};

// Edition default: cloud enforces plan quotas before connect/create —
// injected by `ensureEditionDefaults()`, keeping the quota service (and its
// Redis client) out of client bundles; onprem has no quotas.
const slot = createEditionSlot<ConnectionHooks>(
  "connectionHooks",
  noopConnectionHooks,
);

/** Test seam — the uniform slot override (`null` resets to the edition default). */
export const initConnectionHooks = (h: ConnectionHooks | null) => slot.init(h);

/** Package-internal: the edition-defaults injector. Not exported from the barrel. */
export const setDefaultConnectionHooks = (h: ConnectionHooks) =>
  slot.setCloudDefault(h);

export const getConnectionHooks = (): ConnectionHooks => slot.get();
