import { describe, expect, it, vi } from "vitest";

// ── The agent's hosted desktop does not exist off cloud ─────────────────────
//
// The whole surface is edition-dark on a self-host: a clean 404 for every
// path, whatever the request carries, before authentication and before any
// query. The cloud contract lives in routes.test.ts; `IS_CLOUD` is frozen at
// module load, so the two arms cannot share a file.

vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_EDITION;
  delete process.env.EDITION;
});

// Any DB touch would mean a handler ran past the gate: fail loudly instead.
vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: new Proxy(
    {},
    {
      get: (_t, model: string) =>
        new Proxy(
          {},
          {
            get: (_m, method: string) => async () => {
              throw new Error(
                `db.${model}.${method}() reached on a self-host: the edition gate did not fire`,
              );
            },
          },
        ),
    },
  ),
}));

const { agentDesktopRoutes } = await import("./routes");
const { IS_CLOUD } = await import("../../lib/env");

const CASES = [
  ["GET", "/ag-1/desktop"],
  ["POST", "/ag-1/desktop/wake"],
  ["POST", "/ag-1/desktop/control"],
  ["DELETE", "/ag-1/desktop/control"],
] as const;

describe("the agent desktop on a self-host", () => {
  it("premise: this lane is not cloud", () => {
    // Without this the 404s below could come from a cloud build for some
    // other reason and prove nothing about the edition gate.
    expect(IS_CLOUD).toBe(false);
  });

  it.each(CASES)(
    "%s %s answers the edition-dark 404, even with credentials",
    async (method, path) => {
      const res = await agentDesktopRoutes().request(path, {
        method,
        headers: {
          authorization: "Bearer oc_org_test-key",
          "x-workspace-id": "p1",
        },
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({
        error: { type: "invalid_request_error" },
      });
    },
  );

  it("claims nothing beyond its own paths on the shared /agents base", async () => {
    // Composed onto /agents next to free routers: a "*" gate here would
    // 404 every agent route. An unrelated agent path must fall through.
    const res = await agentDesktopRoutes().request("/ag-1/crons", {
      method: "GET",
    });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("invalid_request_error");
  });
});
