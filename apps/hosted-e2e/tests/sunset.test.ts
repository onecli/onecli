import { expect } from "vitest";
import { scenario } from "../src/scenario.js";
import { seedTenant } from "../src/fixtures.js";

/**
 * The sunset-posture matrix leg (the v2-todo reserved slot, paid by the
 * step-8 flip): this suite runs the ONPREM stack, where the cloud
 * creation-world gate (`Organization.byoLegacy`, sandbox-platform §3.10 as
 * re-decided 2026-08-23) must be INERT — byo creation stays byte-identical
 * whatever the column says, in both directions. The cloud arm of the matrix
 * is proven in packages/api (agent-service{,.pg}.test.ts, the gate reads the
 * edition per call); this leg pins the self-host posture against a live
 * column so a future edition-blind gate cannot land silently.
 */

scenario(
  "self-host ignores the creation-world column: byo creates in both worlds",
  async (cx) => {
    const stack = await cx.startStack({ withRunner: false });
    await seedTenant(cx.prisma, cx.ids);

    // World 1 — the default (byoLegacy false, cloud's hosted-only world):
    // byo creation is untouched here.
    const byoDefault = await stack.v1.post("/v1/agents", {
      name: "byo in the default world",
      identifier: `${cx.ids.nonce}-byo-default`,
      kind: "byo",
    });
    expect(byoDefault.status).toBe(201);

    // World 2 — the stamped org (cloud's BYO-only world): still no gate on
    // self-host, in EITHER direction — byo keeps creating, and hosted keeps
    // answering with the runner-availability 422, never a world 403.
    await cx.prisma.organization.update({
      where: { id: cx.ids.org },
      data: { byoLegacy: true },
    });

    const byoStamped = await stack.v1.post("/v1/agents", {
      name: "byo in the stamped world",
      identifier: `${cx.ids.nonce}-byo-stamped`,
      kind: "byo",
    });
    expect(byoStamped.status).toBe(201);

    const hostedStamped = await stack.v1.post("/v1/agents", {
      name: "hosted in the stamped world",
      identifier: `${cx.ids.nonce}-hosted-stamped`,
      kind: "hosted",
    });
    expect(hostedStamped.status).toBe(422);

    // The org read serves the columns either way — the web's door input — and
    // carries exactly the org object, nothing more.
    const org = await stack.v1.json<Record<string, unknown>>(
      await stack.v1.get("/v1/org"),
    );
    expect(Object.keys(org).sort()).toEqual([
      "byoEnabled",
      "byoLegacy",
      "id",
      "name",
      "slug",
    ]);
    expect(org.byoLegacy).toBe(true);
    expect(org.byoEnabled).toBe(false);
  },
);
