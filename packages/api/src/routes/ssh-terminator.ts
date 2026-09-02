import { Hono } from "hono";
import { z } from "zod";

import { terminatorAuth } from "../middleware/terminator-auth";
import {
  closeSshSession,
  heartbeatSshSession,
  openSshSession,
} from "../services/ssh-service";

/**
 * The SSH terminator's own surface (plans/sandbox-platform.md step 5) — the
 * narrow terminator↔control-plane channel, authenticated by the static
 * SSH_TERMINATOR_SECRET alone (terminator-auth middleware; unset = every
 * call refused, the dark posture). The terminator's word is never trusted
 * for identity: session-open takes the USER'S CERTIFICATE and the service
 * re-verifies it against the CA, deriving every id from signed material.
 *
 * Heartbeats are the kill signal's transport (pull-shaped — nothing can dial
 * into the agent VPC): each one re-runs the access law and reports `revoked`
 * back; the row is closed server-side at detection so keep-awake drops even
 * if the terminator misbehaves.
 */

// A cert line is ~600 bytes; 16 KiB bounds hostile input with headroom.
const openSchema = z.object({
  certificate: z
    .string()
    .min(1)
    .max(16 * 1024),
  sourceIp: z.string().min(1).max(64),
});

const heartbeatSchema = z.object({
  attached: z.boolean().optional(),
});

const closeSchema = z.object({
  reason: z.string().min(1).max(64),
});

export const sshTerminatorRoutes = () => {
  const app = new Hono();
  app.use("*", terminatorAuth);

  // POST /ssh-terminator/sessions — session-open: verify the presented cert,
  // re-run the access law, enforce the lease-aware per-agent cap, audit,
  // wake, and return the CA-signed broker grant.
  app.post("/sessions", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = openSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }
    const opened = await openSshSession(
      parsed.data.certificate,
      parsed.data.sourceIp,
    );
    return c.json(opened);
  });

  // POST /ssh-terminator/sessions/:sessionId/heartbeat — renew the lease,
  // re-check access; `revoked: true` tells the terminator to drop the session.
  app.post("/sessions/:sessionId/heartbeat", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = heartbeatSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }
    const result = await heartbeatSshSession(
      c.req.param("sessionId"),
      parsed.data.attached ?? false,
    );
    return c.json(result);
  });

  // POST /ssh-terminator/sessions/:sessionId/close — idempotent; the service
  // audits only the open→closed transition.
  app.post("/sessions/:sessionId/close", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = closeSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        400,
      );
    }
    await closeSshSession(c.req.param("sessionId"), parsed.data.reason);
    return c.body(null, 204);
  });

  return app;
};
