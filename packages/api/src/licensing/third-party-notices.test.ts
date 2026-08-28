import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Third-party license obligations, pinned the same way the enterprise
 * boundary is: as executable claims. Each assertion is an obligation we owe
 * an upstream project — deleting the artifact or the credit breaks the suite,
 * not just the paperwork.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const read = (path: string): string =>
  readFileSync(`${REPO_ROOT}${path}`, "utf8");

describe("third-party notices", () => {
  it("the Geist fonts ship with their OFL license text", () => {
    // MUTATION-TESTED (the OFL artifact): delete OFL.txt and the vendored
    // Geist woffs are redistributed in violation of SIL OFL 1.1, which
    // requires the copyright notice and license to accompany every copy of
    // the Font Software. The file must sit BESIDE the fonts — the public
    // mirror redistributes the directory, not this repository's root.
    const ofl = read("apps/web/src/app/fonts/OFL.txt");
    expect(ofl).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(ofl).toContain("The Geist Project Authors");
  });

  it("NOTICE credits the bundled third-party material", () => {
    // MUTATION-TESTED (the attribution): strip either credit and a shipped
    // third-party obligation goes silent — shadcn/ui's MIT notice ask, and
    // the OFL attribution that tells a reader where the license text lives.
    const notice = read("NOTICE");
    expect(notice, "shadcn/ui MIT credit").toContain("shadcn/ui");
    expect(notice, "Geist OFL credit").toContain("Geist");
    expect(notice, "OFL pointer").toContain("SIL Open Font License");
  });
});
