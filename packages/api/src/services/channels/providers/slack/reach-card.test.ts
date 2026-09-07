import { describe, expect, it } from "vitest";
import { reachCardBlocks, slackReach } from "./reach-card";

/**
 * The gate-hardening card behaviors (PR 4a):
 *  - the lateness line: an old ask says its age, a fresh one carries nothing;
 *  - the `expired` settle copy: honest about what happened (the ask aged
 *    out / the subject vanished) — never the `left` text, which would claim
 *    a removal that didn't happen.
 *
 * Rendering-only tests: the sweep and recheck behaviors live in the pg
 * proofs (agent-reach.pg.test.ts); this pins the copy they produce.
 */

const flat = (blocks: unknown[]): string => JSON.stringify(blocks);

describe("reachCardBlocks — the lateness line", () => {
  const base = {
    grantId: "g-1",
    agentName: "Donna",
    subjectLabel: "#proj-x",
  };

  it("a fresh card carries no age line", () => {
    expect(flat(reachCardBlocks(base))).not.toContain("First asked");
    expect(
      flat(reachCardBlocks({ ...base, firstAskedDaysAgo: 0 })),
    ).not.toContain("First asked");
  });

  it("an old ask says how old it is, singular and plural", () => {
    expect(flat(reachCardBlocks({ ...base, firstAskedDaysAgo: 1 }))).toContain(
      "First asked 1 day ago.",
    );
    expect(flat(reachCardBlocks({ ...base, firstAskedDaysAgo: 12 }))).toContain(
      "First asked 12 days ago.",
    );
  });

  it("the age line rides the person card too", () => {
    expect(
      flat(
        reachCardBlocks({
          ...base,
          subjectKind: "external_user",
          firstAskedDaysAgo: 5,
        }),
      ),
    ).toContain("First asked 5 days ago.");
  });
});

describe("verifySubject — fail-open contract without a credential", () => {
  it("no credential answers ok (cannot check ≠ refuse)", async () => {
    await expect(
      slackReach.verifySubject({
        credentialsJson: null,
        subjectKind: "space",
        externalRef: "C-ANY",
        tenantExternalId: "T-ANY",
      }),
    ).resolves.toEqual({ ok: true });
  });
});
