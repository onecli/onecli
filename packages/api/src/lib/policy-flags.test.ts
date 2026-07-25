import { afterEach, describe, expect, it } from "vitest";
import { isOssEdition } from "./policy-flags";

// The OSS edition drives how the shared policy service phrases capability
// rejections (a OneCLI Cloud pointer there, byte-identical everywhere else), so
// the edition resolution itself is pinned: EDITION first, NEXT_PUBLIC_EDITION as
// the fallback, and an unset/unknown value parsing as OSS.
describe("isOssEdition", () => {
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
    ["oss", true],
    ["onprem-slim", false],
    ["onprem-full", false],
    ["cloud", false],
    ["", true], // unset edition parses as oss
  ])("edition %s → %s", (edition, expected) => {
    delete process.env.NEXT_PUBLIC_EDITION;
    process.env.EDITION = edition;
    expect(isOssEdition()).toBe(expected);
  });

  it("falls back to NEXT_PUBLIC_EDITION when EDITION is unset", () => {
    delete process.env.EDITION;
    process.env.NEXT_PUBLIC_EDITION = "cloud";
    expect(isOssEdition()).toBe(false);
  });
});
