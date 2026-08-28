import { afterEach, describe, expect, it } from "vitest";
import { isOnpremEdition } from "./policy-flags";

// The onprem edition drives how the shared policy service phrases capability
// rejections (a OneCLI Cloud pointer there, byte-identical everywhere else), so
// the edition resolution itself is pinned: EDITION first, NEXT_PUBLIC_EDITION as
// the fallback, and an unset/unknown value parsing as onprem.
describe("isOnpremEdition", () => {
  const originalEdition = process.env.EDITION;
  const originalPublicEdition = process.env.NEXT_PUBLIC_EDITION;

  afterEach(() => {
    if (originalEdition === undefined) delete process.env.EDITION;
    else process.env.EDITION = originalEdition;
    if (originalPublicEdition === undefined)
      delete process.env.NEXT_PUBLIC_EDITION;
    else process.env.NEXT_PUBLIC_EDITION = originalPublicEdition;
  });

  it.each([
    ["onprem", true],
    ["oss", true], // legacy value parses as onprem
    ["cloud", false],
    ["", true], // unset edition parses as onprem
  ])("edition %s → %s", (edition, expected) => {
    delete process.env.NEXT_PUBLIC_EDITION;
    process.env.EDITION = edition;
    expect(isOnpremEdition()).toBe(expected);
  });

  it("falls back to NEXT_PUBLIC_EDITION when EDITION is unset", () => {
    delete process.env.EDITION;
    process.env.NEXT_PUBLIC_EDITION = "cloud";
    expect(isOnpremEdition()).toBe(false);
  });
});
