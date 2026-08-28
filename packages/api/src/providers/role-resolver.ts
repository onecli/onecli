import type { RoleResolver } from "./types";
import { createEditionSlot } from "./edition-state";

// Edition default: cloud resolves org roles from the membership table (RBAC)
// — injected by `ensureEditionDefaults()`, keeping the authorization service
// (and its DB client) out of client bundles; onprem has no resolver, so
// role-dependent reads fail safe to non-admin. The `roleResolver` option and
// `initRoleResolver` remain as overrides for tests (null resets to the
// edition default).
const slot = createEditionSlot<RoleResolver | null>("roleResolver", null);

export const initRoleResolver = (r: RoleResolver | null) => slot.init(r);

/** Package-internal: the edition-defaults injector. Not exported from the barrel. */
export const setDefaultRoleResolver = (r: RoleResolver) =>
  slot.setCloudDefault(r);

export const getRoleResolver = (): RoleResolver | null => slot.get();
