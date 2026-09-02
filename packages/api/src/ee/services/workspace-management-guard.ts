import type { AuthContext } from "../../providers";
import { ServiceError } from "../../services/errors";
import {
  canManageWorkspace,
  canAccessWorkspace,
} from "./authorization-service";

/**
 * Gate a workspace-management action (rename / delete / edit shares). Allowed for
 * an owner-role WorkspaceAccess binding holder or an org admin/owner (step 13c) —
 * never a plain shared-in (member) binding.
 * A *workspace-scoped* API key is further confined to its own workspace, so a leaked
 * key can't *manage* the user's sibling workspaces (this guards the management
 * surface only — the read routes are intentionally unchanged). On denial we
 * distinguish a caller who can *see* the workspace (403 — a clear "you can't
 * manage this") from one who can't (404 — no existence leak), not always 404.
 *
 * Lives in its own module so the 403-vs-404 policy can be unit-tested at the
 * branch level with the two access predicates mocked.
 */
export const requireWorkspaceManagement = async (
  authCtx: AuthContext,
  targetId: string,
): Promise<void> => {
  if (authCtx.scope === "workspace" && authCtx.workspaceId !== targetId) {
    throw new ServiceError("NOT_FOUND", "Workspace not found");
  }
  if (await canManageWorkspace(authCtx.userId, targetId)) return;
  if (await canAccessWorkspace(authCtx.userId, targetId)) {
    throw new ServiceError(
      "FORBIDDEN",
      "You don't have permission to manage this workspace",
    );
  }
  throw new ServiceError("NOT_FOUND", "Workspace not found");
};
