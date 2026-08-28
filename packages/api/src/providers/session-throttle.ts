import type { SessionThrottle } from "./types";
import { createEditionSlot } from "./edition-state";

// Edition default: cloud rate-limits /auth/session per client IP (the
// unauthenticated endpoint that performs the user/org bootstrap writes) —
// injected by `ensureEditionDefaults()`, keeping the Redis limiter out of
// client bundles; onprem never throttles.
const slot = createEditionSlot<SessionThrottle | null>("sessionThrottle", null);

/** Null resets to the edition default — used by tests. */
export const initSessionThrottle = (t: SessionThrottle | null) => slot.init(t);

/** Package-internal: the edition-defaults injector. Not exported from the barrel. */
export const setDefaultSessionThrottle = (t: SessionThrottle) =>
  slot.setCloudDefault(t);

export const getSessionThrottle = (): SessionThrottle | null => slot.get();
