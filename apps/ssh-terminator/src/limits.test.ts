import { describe, expect, it } from "vitest";
import { createConnectionLimits } from "./limits";

const make = (over: {
  maxSessions?: number;
  maxSessionsPerIp?: number;
  preauthPerIpPerMinute?: number;
  now?: () => number;
}) =>
  createConnectionLimits({
    maxSessions: over.maxSessions ?? 100,
    maxSessionsPerIp: over.maxSessionsPerIp ?? 10,
    preauthPerIpPerMinute: over.preauthPerIpPerMinute ?? 60,
    now: over.now,
  });

describe("createConnectionLimits", () => {
  it("enforces the global concurrent cap and frees on release", () => {
    const limits = make({ maxSessions: 2, preauthPerIpPerMinute: 1000 });
    const a = limits.admit("1.1.1.1");
    const b = limits.admit("2.2.2.2");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(limits.admit("3.3.3.3")).toBeNull();
    a?.();
    expect(limits.admit("3.3.3.3")).not.toBeNull();
  });

  it("enforces the per-IP concurrent cap independently of other IPs", () => {
    const limits = make({ maxSessionsPerIp: 2, preauthPerIpPerMinute: 1000 });
    expect(limits.admit("9.9.9.9")).not.toBeNull();
    expect(limits.admit("9.9.9.9")).not.toBeNull();
    expect(limits.admit("9.9.9.9")).toBeNull();
    expect(limits.admit("8.8.8.8")).not.toBeNull();
  });

  it("release is idempotent — a double release cannot free a stranger's slot", () => {
    const limits = make({ maxSessions: 1, preauthPerIpPerMinute: 1000 });
    const release = limits.admit("1.1.1.1");
    release?.();
    release?.();
    expect(limits.admit("2.2.2.2")).not.toBeNull();
    expect(limits.admit("3.3.3.3")).toBeNull();
  });

  it("rate-limits attempts per IP with a refilling token bucket", () => {
    let at = 0;
    const limits = make({ preauthPerIpPerMinute: 6, now: () => at });
    // Burst to the full bucket, releasing each so only the RATE gates.
    for (let i = 0; i < 6; i += 1) {
      const release = limits.admit("5.5.5.5");
      expect(release).not.toBeNull();
      release?.();
    }
    expect(limits.admit("5.5.5.5")).toBeNull();
    // 6/min = one token per 10s.
    at += 10_000;
    const release = limits.admit("5.5.5.5");
    expect(release).not.toBeNull();
    release?.();
    expect(limits.admit("5.5.5.5")).toBeNull();
    // The bucket refills to capacity but never beyond it.
    at += 600_000;
    for (let i = 0; i < 6; i += 1) {
      const again = limits.admit("5.5.5.5");
      expect(again).not.toBeNull();
      again?.();
    }
    expect(limits.admit("5.5.5.5")).toBeNull();
  });

  it("one IP burning its bucket does not affect another", () => {
    const at = 0;
    const limits = make({ preauthPerIpPerMinute: 2, now: () => at });
    limits.admit("1.1.1.1")?.();
    limits.admit("1.1.1.1")?.();
    expect(limits.admit("1.1.1.1")).toBeNull();
    expect(limits.admit("2.2.2.2")).not.toBeNull();
  });
});
