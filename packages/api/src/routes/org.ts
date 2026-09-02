import { Hono } from "hono";
import { db } from "@onecli/db";
import type { ApiEnv } from "../types";
import { auth } from "../middleware/auth";
import { ServiceError } from "../services/errors";

// The current organization, resolved from the membership-fenced auth context —
// never from input, so cross-org reads are impossible by construction.
// `role: "member"` runs the active-membership re-fence for API keys (a departed
// member's key must not keep reading org facts). Middleware is per-handler on
// purpose: this router mounts at /org, and Hono's route() copies a `use("*")`
// onto the parent as /org/*, which would impose this auth on every other
// /v1/org/... router.
const member = auth({ requireWorkspace: false, role: "member" });

export const orgRoutes = () => {
  const app = new Hono<ApiEnv>();

  // GET /v1/org — the org object plus its creation-world posture. `byoLegacy`
  // is the manually-operated per-org switch (sandbox-platform §3.10 as
  // re-decided 2026-08-23): on cloud, false = hosted-first creation, true =
  // BYO-only creation. `byoEnabled` (mixed world, 2026-08-29) is only read
  // when `byoLegacy` is false: it additionally allows BYO creation beside the
  // hosted default. Both inert on self-host — the web ignores them there.
  app.get("/", member, async (c) => {
    const authCtx = c.get("auth");
    const org = await db.organization.findUnique({
      where: { id: authCtx.organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        byoLegacy: true,
        byoEnabled: true,
      },
    });
    if (!org) {
      throw new ServiceError("NOT_FOUND", "Organization not found");
    }
    return c.json(org);
  });

  return app;
};
