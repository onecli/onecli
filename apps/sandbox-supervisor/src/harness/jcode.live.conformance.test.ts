import { describe, expect, it } from "vitest";
import { runHarnessConformance } from "./conformance";
import { createJcodeHarness } from "./jcode";

/**
 * The LIVE conformance run for the real adapter — env-gated like the pg
 * proof suites, because it needs the bundled jcode runtime plus a credential
 * path (either a real key, or placeholder env + a dev gateway injecting).
 *
 *   JCODE_LIVE_TEST=1 AGENT_MODEL=... pnpm --filter @onecli/sandbox-supervisor \
 *     exec vitest run src/harness/jcode.live.conformance.test.ts
 */
const LIVE = Boolean(process.env.JCODE_LIVE_TEST);

/**
 * The gate holds ONE real test rather than being empty.
 *
 * vitest errors on a file with no tests, so the file needs one in the skipped
 * case — and an empty `describe` is itself "no test found", which failed the
 * suite in the OPTED-IN case even when all five conformance tests passed. One
 * cheap assertion (building the adapter launches nothing) satisfies both.
 */
describe("jcode live gate", () => {
  it.skipIf(!LIVE)("declares the capabilities the suite exercises", () => {
    expect(createJcodeHarness().capabilities).toMatchObject({
      resume: true,
      toolEvents: true,
    });
  });
});

if (LIVE) {
  runHarnessConformance({
    name: "jcode (live)",
    makeHarness: () => Promise.resolve(createJcodeHarness()),
    expectToolUse: false,
    timeoutMs: 180_000,
  });
}
