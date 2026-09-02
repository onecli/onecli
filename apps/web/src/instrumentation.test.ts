import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The law: the web server applies the edition defaults as a property of the
 * PROCESS — `register()` runs them before any request. When this relied on a
 * module import (`@/lib/init/server` via resolve-user.ts), renders whose
 * graph never loaded that file ran with empty provider seams; on an entitled
 * self-host the null role resolver silently denied the workspace's own owner
 * and bounced the browser to /org on first open.
 */

const called = vi.hoisted(() => ({ n: 0 }));

vi.mock("@onecli/api", () => ({
  ensureEditionDefaults: () => {
    called.n += 1;
  },
}));

vi.mock("@/lib/env", () => ({ NODE_ENV: "test", LOG_LEVEL: "info" }));

import { register } from "./instrumentation";

const savedRuntime = process.env.NEXT_RUNTIME;

beforeEach(() => {
  called.n = 0;
});

afterEach(() => {
  if (savedRuntime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = savedRuntime;
});

describe("instrumentation register", () => {
  it("applies the edition defaults on nodejs process start", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    await register();
    expect(called.n).toBe(1);
  });

  it("never pulls the server-heavy graph into the edge runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    await register();
    expect(called.n).toBe(0);
  });
});
