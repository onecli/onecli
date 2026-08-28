import { expect } from "vitest";
import { scenario } from "../src/scenario.js";
import { seedTenant } from "../src/fixtures.js";

/**
 * The §3.13 auto-hide proof, stack level (the v2→main merge gate): with NO
 * runner ever registered — cloud's exact posture on deploy day — the API
 * says so, refuses hosted creation, and byo creation is untouched
 * (invariant 13's byte-identical clause). Docker-free: `withRunner:false`
 * spawns only the gateway + api-server children.
 */

scenario(
  "no runner: instance says absent, hosted create 422, byo unchanged",
  async (cx) => {
    const stack = await cx.startStack({ withRunner: false });
    await seedTenant(cx.prisma, cx.ids);

    const instance = await stack.v1.json<{
      runners: { registered: boolean; online: boolean };
    }>(await stack.v1.get("/v1/instance"));
    expect(instance.runners).toEqual({ registered: false, online: false });

    const hosted = await stack.v1.post("/v1/agents", {
      name: "hosted hopeful",
      identifier: `${cx.ids.nonce}-hosted`,
      kind: "hosted",
    });
    expect(hosted.status).toBe(422);

    const byo = await stack.v1.post("/v1/agents", {
      name: "byo still fine",
      identifier: `${cx.ids.nonce}-byo`,
      kind: "byo",
    });
    expect(byo.status).toBe(201);
  },
);

scenario(
  "a registered runner flips the same install to available",
  async (cx) => {
    const stack = await cx.startStack();
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);

    const instance = await stack.v1.json<{
      runners: { registered: boolean; online: boolean };
    }>(await stack.v1.get("/v1/instance"));
    expect(instance.runners.registered).toBe(true);
    expect(instance.runners.online).toBe(true);
  },
);
