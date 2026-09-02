import { describe, expect, it, vi } from "vitest";

// ── Resend intake does not exist off cloud ──────────────────────────────────
//
// The intake is hosted-platform plumbing: our Resend account posts to it. On a
// self-host the surface is edition-dark — a clean 404 — so no operator there
// ever needs a signing secret, and no ambient DISCORD/RESEND env inherited
// from a copied file can wake it up. The signature behavior (cloud) lives in
// webhooks.test.ts; `IS_CLOUD` is frozen at module load, so the two arms
// cannot share a file.

vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_EDITION;
  delete process.env.EDITION;
});

// Any DB touch would mean a handler ran past the gate — fail loudly instead.
vi.mock("@onecli/db", () => ({
  db: new Proxy(
    {},
    {
      get: (_t, model: string) =>
        new Proxy(
          {},
          {
            get: (_m, method: string) => async () => {
              throw new Error(
                `db.${model}.${method}() reached on a self-host — the edition gate did not fire`,
              );
            },
          },
        ),
    },
  ),
}));

const { webhookRoutes } = await import("./webhooks");
const { CAPS } = await import("../../lib/env");

describe("resend intake on a self-host", () => {
  it("premise: this lane is not cloud", () => {
    // Without this the 404s below could come from a cloud build for some
    // other reason and prove nothing about the edition gate.
    expect(CAPS.billing).toBe(false);
  });

  it.each(["/resend", "/inbound"])(
    "%s answers the edition-dark 404, whatever the request carries",
    async (path) => {
      // A perfectly-shaped (if unsigned) delivery, and even a configured
      // secret: neither can reach a handler here.
      const res = await webhookRoutes().request(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "svix-id": "msg_1",
          "svix-timestamp": String(Math.floor(Date.now() / 1000)),
          "svix-signature": "v1,whatever",
        },
        body: JSON.stringify({ type: "email.delivered", data: {} }),
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({
        error: { type: "invalid_request_error" },
      });
    },
  );
});
