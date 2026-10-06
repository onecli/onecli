import { Hono } from "hono";
import { requireEnterprise } from "../middleware/enterprise-gate";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { requiredConnectionId } from "./folder-route-params";
import {
  listGoogleDriveFolders,
  resolveGoogleDriveFolderNames,
} from "../services/google-drive-folder-service";

const read = auth({ requireWorkspace: false });

export const googleDriveFolderRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", requireEnterprise("granular_access"));

  // GET /folders?connectionId=...&parentId=<folderId>  → subfolders of the
  // folder (no parentId = My Drive's top level plus shared drives). The
  // dashboard browses Drive live, like Dropbox. Service throws map to HTTP via
  // the app-level error handler.
  app.get("/folders", read, async (c) => {
    const { organizationId, workspaceId } = c.get("auth");
    const parentId = c.req.query("parentId") || undefined;
    const folders = await listGoogleDriveFolders(
      { organizationId, workspaceId },
      requiredConnectionId(c),
      parentId,
    );
    return c.json(folders);
  });

  // GET /folder-names?connectionId=...&ids=a,b  → { a: "Name", b: null }.
  // Saved policies hold folder-ID chains; the picker labels them with these.
  app.get("/folder-names", read, async (c) => {
    const { organizationId, workspaceId } = c.get("auth");
    const ids = (c.req.query("ids") ?? "").split(",").filter(Boolean);
    const names = await resolveGoogleDriveFolderNames(
      { organizationId, workspaceId },
      requiredConnectionId(c),
      ids,
    );
    return c.json(names);
  });

  return app;
};
