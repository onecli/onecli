import { Hono } from "hono";
import { requireEnterprise } from "../middleware/enterprise-gate";
import type { ApiEnv } from "../../types";
import { auth } from "../../middleware/auth";
import { listDropboxFolders } from "../services/dropbox-folder-service";

const read = auth({ requireWorkspace: false });

export const dropboxFolderRoutes = () => {
  const app = new Hono<ApiEnv>();
  app.use("*", requireEnterprise("granular_access"));

  // GET /folders?connectionId=...&path=/Clients  → subfolders of `path`.
  // The dashboard browses Dropbox live (no connect-time folder list), so this
  // proxies a scoped `list_folder` call. Service throws map to HTTP via the
  // app-level error handler.
  app.get("/folders", read, async (c) => {
    const { organizationId } = c.get("auth");
    const connectionId = c.req.query("connectionId");
    if (!connectionId) {
      return c.json({ error: "connectionId is required" }, 400);
    }
    const path = c.req.query("path") ?? "";
    const folders = await listDropboxFolders(
      organizationId,
      connectionId,
      path,
    );
    return c.json(folders);
  });

  return app;
};
