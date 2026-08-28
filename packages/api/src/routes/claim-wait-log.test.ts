import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createLogClaimWait } from "../services/claim-wait-log";
import {
  WORK_CLAIMED_LOG_MSG,
  WORK_CLAIMED_WAIT_FIELD,
} from "../services/due-work";

/**
 * The claim-wait line is a METRIC CARRIER (the cloud's TurnQueueSeconds
 * filter reads it from the api-server log group), and prod runs
 * LOG_LEVEL=warn — the step-6 review found the naive `log.info` never exists
 * in exactly the environment the alarm watches. These tests drive the REAL
 * factories the route wires (not a re-derivation of the mechanism), so a
 * regression in the shipped code fails here.
 */

const captured = (): { root: pino.Logger; lines: string[] } => {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  // warn root = the prod api-server shape (api-server-stack LOG_LEVEL).
  return { root: pino({ level: "warn" }, sink), lines };
};

describe("claim-wait log line (step 6)", () => {
  it("CLOUD: the line is emitted under a warn-level root — the pinned-info child survives prod's LOG_LEVEL", () => {
    const { root, lines } = captured();
    const logClaimWait = createLogClaimWait(root, true);

    root.info("swallowed at the root level");
    logClaimWait(new Date(Date.now() - 1230), "t1");

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed.msg).toBe(WORK_CLAIMED_LOG_MSG);
    expect(parsed.turnId).toBe("t1");
    const waited = parsed[WORK_CLAIMED_WAIT_FIELD];
    expect(typeof waited).toBe("number");
    expect(waited as number).toBeGreaterThanOrEqual(1);
    expect(waited as number).toBeLessThan(5);
  });

  it("ONPREM: the operator's root level stands — no filter reads the line, so warn silences it", () => {
    const { root, lines } = captured();
    const logClaimWait = createLogClaimWait(root, false);
    logClaimWait(new Date(), "t1");
    expect(lines).toHaveLength(0);
  });

  it("tolerates a missing waited_since and a skewed clock — telemetry never logs garbage", () => {
    const { root, lines } = captured();
    const logClaimWait = createLogClaimWait(root, true);
    logClaimWait(undefined, "t1");
    logClaimWait(new Date(Date.now() + 60_000), "t2"); // negative wait
    expect(lines).toHaveLength(0);
  });

  it("a throwing logger never breaks the claim path", () => {
    const throwing = {
      child() {
        return this;
      },
      info: () => {
        throw new Error("sink died");
      },
    } as unknown as pino.Logger;
    const logClaimWait = createLogClaimWait(throwing, true);
    expect(() => logClaimWait(new Date(), "t1")).not.toThrow();
  });
});
