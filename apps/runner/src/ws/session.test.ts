import { describe, expect, it } from "vitest";
import { parseSessionKeyring } from "./session";

const KEY_A = "k1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY_B = "k2.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/**
 * The session credential is what lets a RESTARTED runner (or a sibling) accept
 * a supervisor's reconnect without any shared store: an HMAC over the
 * sandbox and its container under a fleet key. These pin the properties the
 * channel's safety rests on — a credential opens exactly one sandbox's
 * channel for exactly one container, under a key the fleet still trusts.
 */
describe("session keyring", () => {
  it("is absent when no key is configured — resumption off, today's behaviour", () => {
    expect(parseSessionKeyring(undefined)).toBeNull();
    expect(parseSessionKeyring("")).toBeNull();
    expect(parseSessionKeyring("   ")).toBeNull();
  });

  it("signs and verifies a credential bound to one sandbox and one container", () => {
    const ring = parseSessionKeyring(KEY_A);
    expect(ring).not.toBeNull();
    const credential = ring!.sign("sbx-1", "ctr-1");
    expect(credential).toMatch(/^v1\.k1\.[0-9a-f]{64}$/);
    expect(ring!.verify(credential, "sbx-1", "ctr-1")).toBe(true);
  });

  it("refuses the credential for any other sandbox or container", () => {
    const ring = parseSessionKeyring(KEY_A)!;
    const credential = ring.sign("sbx-1", "ctr-1");
    expect(ring.verify(credential, "sbx-2", "ctr-1")).toBe(false);
    expect(ring.verify(credential, "sbx-1", "ctr-2")).toBe(false);
    // A recreated container is a new identity: the old credential is dead.
    expect(ring.verify(credential, "sbx-1", "ctr-1-recreated")).toBe(false);
  });

  it("does not let the two inputs be confused for each other", () => {
    // sign("a", "b") must never verify as ("ab", "") or any other split: the
    // message is framed, not concatenated.
    const ring = parseSessionKeyring(KEY_A)!;
    const credential = ring.sign("ab", "c");
    expect(ring.verify(credential, "a", "bc")).toBe(false);
    expect(ring.verify(credential, "abc", "")).toBe(false);
  });

  it("refuses a credential signed under a key the ring does not hold", () => {
    const a = parseSessionKeyring(KEY_A)!;
    const b = parseSessionKeyring(KEY_B)!;
    expect(b.verify(a.sign("sbx-1", "ctr-1"), "sbx-1", "ctr-1")).toBe(false);
  });

  it("rotates: the first key signs, every key verifies", () => {
    const old = parseSessionKeyring(KEY_A)!;
    const issuedUnderOld = old.sign("sbx-1", "ctr-1");

    // Rotation step 1: `new,old` — new sessions get k2, old ones still work.
    const overlap = parseSessionKeyring(`${KEY_B},${KEY_A}`)!;
    expect(overlap.sign("sbx-1", "ctr-1")).toMatch(/^v1\.k2\./);
    expect(overlap.verify(issuedUnderOld, "sbx-1", "ctr-1")).toBe(true);

    // Rotation step 2: `new` only — the old sessions are gone.
    const rotated = parseSessionKeyring(KEY_B)!;
    expect(rotated.verify(issuedUnderOld, "sbx-1", "ctr-1")).toBe(false);
    expect(
      rotated.verify(overlap.sign("sbx-1", "ctr-1"), "sbx-1", "ctr-1"),
    ).toBe(true);
  });

  it("refuses malformed credentials without throwing", () => {
    const ring = parseSessionKeyring(KEY_A)!;
    for (const bad of [
      "",
      "v1",
      "v1.k1",
      "v1.k1.nothex",
      "v2.k1." + "0".repeat(64),
      "v1.k9." + "0".repeat(64),
      "v1.k1." + "0".repeat(63),
      "v1.k1." + "0".repeat(65),
    ]) {
      expect(ring.verify(bad, "sbx-1", "ctr-1")).toBe(false);
    }
  });

  it("accepts a bare secret as a one-key ring under the default kid — a single generated value", () => {
    const ring = parseSessionKeyring(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )!;
    expect(ring.sign("sbx-1", "ctr-1")).toMatch(/^v1\.default\./);
    // And it rotates into the explicit shape without changing the key id's
    // meaning: `k2.…,default.<same>` keeps the bare-era sessions valid.
    const overlap = parseSessionKeyring(
      `${KEY_B},default.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    )!;
    expect(overlap.verify(ring.sign("sbx-1", "ctr-1"), "sbx-1", "ctr-1")).toBe(
      true,
    );
  });

  it("rejects a keyring with a malformed entry, so a typo never silently disables resumption", () => {
    expect(() => parseSessionKeyring("k1.")).toThrow(/kid\.secret/);
    expect(() => parseSessionKeyring(".secret")).toThrow(/kid\.secret/);
    expect(() => parseSessionKeyring("k1.a.b")).toThrow(/kid\.secret/);
    expect(() => parseSessionKeyring("k 1.secret")).toThrow(/kid\.secret/);
    expect(() => parseSessionKeyring(`${KEY_A},${KEY_A}`)).toThrow(/duplicate/);
    expect(() => parseSessionKeyring(`${KEY_A},`)).toThrow(/kid\.secret/);
  });
});
