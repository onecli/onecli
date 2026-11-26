import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformJob, PlatformJobRuns } from "./platform-jobs";

// The platform-job registry: what every site that applies a run rule
// consults. A wrong answer here silently changes how a run behaves (a
// resumed session, a box held awake, an unsealed conversation), so the
// registration laws are pinned. The registry is module state: each test
// takes a fresh module so registrations never leak between them.

type Registry = typeof import("./platform-jobs");
let registry: Registry;

beforeEach(async () => {
  vi.resetModules();
  registry = await import("./platform-jobs");
});

const job = (overrides: Partial<PlatformJob> = {}): PlatformJob => ({
  name: "job-a",
  passIntervalMs: 1000,
  pass: async () => undefined,
  ...overrides,
});

const runs = (source: PlatformJobRuns["source"]): PlatformJobRuns => ({
  source,
  context: async () => null,
});

/** A run source for the registry's own laws: any allowed source will do,
 * the registry gives it meaning only by registration. */
const SOURCE: PlatformJobRuns["source"] = "memory_review";

describe("platform job registry", () => {
  it("lists registered jobs in registration order, and answers their run sources", () => {
    const review = job({ name: "review", runs: runs(SOURCE) });
    const tidy = job({ name: "tidy" });
    registry.registerPlatformJob(review);
    registry.registerPlatformJob(tidy);

    expect([...registry.platformJobs()]).toEqual([review, tidy]);
    expect(registry.platformJobRunsOf(SOURCE)).toBe(review.runs);
    expect(registry.isPlatformJobRun(SOURCE)).toBe(true);
  });

  it("a job with no run shape is no run source, and neither is an unknown source", () => {
    registry.registerPlatformJob(job({ name: "tidy" }));

    expect(registry.isPlatformJobRun("tidy")).toBe(false);
    expect(registry.isPlatformJobRun("web")).toBe(false);
    expect(registry.platformJobRunsOf("web")).toBeUndefined();
  });

  it("registering the same job twice is a no-op (every createApiApp registers)", () => {
    const review = job({ runs: runs(SOURCE) });
    registry.registerPlatformJob(review);
    registry.registerPlatformJob(review);

    expect([...registry.platformJobs()]).toHaveLength(1);
  });

  it("refuses a second job under a taken name", () => {
    registry.registerPlatformJob(job());

    expect(() => registry.registerPlatformJob(job())).toThrow(
      "platform job already registered: job-a",
    );
  });

  it("refuses a second job claiming a taken run source, and keeps the first", () => {
    const first = job({ name: "first", runs: runs(SOURCE) });
    registry.registerPlatformJob(first);

    expect(() =>
      registry.registerPlatformJob(job({ name: "second", runs: runs(SOURCE) })),
    ).toThrow(`platform job run source already registered: ${SOURCE}`);
    expect(registry.platformJobRunsOf(SOURCE)).toBe(first.runs);
    expect([...registry.platformJobs()]).toEqual([first]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a pass interval of %s",
    (passIntervalMs) => {
      expect(() =>
        registry.registerPlatformJob(job({ passIntervalMs })),
      ).toThrow("passIntervalMs must be > 0");
      expect([...registry.platformJobs()]).toHaveLength(0);
    },
  );
});
