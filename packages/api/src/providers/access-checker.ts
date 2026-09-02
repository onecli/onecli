import type { WorkspaceAccessChecker } from "./types";
import { createEditionSlot } from "./edition-state";

// Edition default: cloud (and a licensed self-host, via `initWorkspaceAccessChecker`
// in `ensureEditionDefaults()`) answers the workspace-access and org-admin
// questions from the licensed authorization service — keeping that service
// (and its DB client) out of client bundles; onprem has no checker, and the
// shared predicates in `services/workspace-access-check.ts` never consult the
// slot there (`!CAPS.rbac` short-circuits to the flat team's always-allowed).
// A missing checker under rbac is a host wiring bug and denies loudly at the
// call site, mirroring the role-resolver slot.
const slot = createEditionSlot<WorkspaceAccessChecker | null>(
  "workspaceAccessChecker",
  null,
);

export const initWorkspaceAccessChecker = (c: WorkspaceAccessChecker | null) =>
  slot.init(c);

/** Package-internal: the edition-defaults injector. Not exported from the barrel. */
export const setDefaultWorkspaceAccessChecker = (c: WorkspaceAccessChecker) =>
  slot.setCloudDefault(c);

export const getWorkspaceAccessChecker = (): WorkspaceAccessChecker | null =>
  slot.get();
