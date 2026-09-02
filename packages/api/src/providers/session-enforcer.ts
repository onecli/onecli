import type { SessionEnforcer } from "./types";
import { createEditionSlot } from "./edition-state";

// Edition default: cloud applies enterprise "require SSO" to every
// authenticated session — injected by `ensureEditionDefaults()`, keeping the
// SSO module out of client bundles; onprem never enforces.
const slot = createEditionSlot<SessionEnforcer | null>("sessionEnforcer", null);

/** Null resets to the edition default — used by tests. */
export const initSessionEnforcer = (e: SessionEnforcer | null) => slot.init(e);

/** Package-internal: the edition-defaults injector. Not exported from the barrel. */
export const setDefaultSessionEnforcer = (e: SessionEnforcer) =>
  slot.setCloudDefault(e);

export const getSessionEnforcer = (): SessionEnforcer | null => slot.get();
