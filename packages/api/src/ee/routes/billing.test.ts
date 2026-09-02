import { afterEach, describe, expect, it, vi } from "vitest";

// Billing is a hosted-platform capability (CAPS.billing): on self-host the
// router must refuse cleanly before auth or Stripe ever run. This used to be
// enforced only by accident — the null role resolver 403'd the admin-gated
// handlers — and the flat-team role posture removed that accident, so the
// capability gate is now the one shield. Pin onprem (CAPS captured at lib/env
// load).
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

// Both directions of the gate ride CAPS.billing (captured at lib/env load) —
// flip it through a mutable getter.
const caps = vi.hoisted(() => ({ billing: false }));

vi.mock("../../lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/env")>();
  return {
    ...actual,
    CAPS: {
      ...actual.CAPS,
      get billing() {
        return caps.billing;
      },
    },
  };
});

vi.mock("@onecli/db", () => ({ Prisma: {}, db: {} }));

import { billingRoutes } from "./billing";
import { initSession } from "../../providers/session";

describe("billingRoutes capability gate", () => {
  afterEach(() => {
    caps.billing = false;
  });

  it("404s billing on a deployment without the capability, before auth", async () => {
    const res = await billingRoutes().request("/checkout", { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: {
        message: "Billing is not available on this deployment",
        type: "invalid_request_error",
      },
    });
  });

  it("stands down where billing exists — the request reaches auth", async () => {
    caps.billing = true;
    initSession({ getSession: async () => null });
    const res = await billingRoutes().request("/checkout", { method: "POST" });
    // No credentials on the request: a 401 from the auth middleware proves
    // the capability gate let it through (a 404 would mean it did not).
    expect(res.status).toBe(401);
  });
});
