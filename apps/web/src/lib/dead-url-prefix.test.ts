import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * The workspace URL scheme is `/w/<workspaceId>`; the old `/p/<projectId>`
 * prefix is retired and no route serves it. Nothing else can enforce that:
 * every internal link is a template literal, so a stale prefix typechecks,
 * lints, renders, and only fails when a user clicks it.
 *
 * The project→workspace rename shipped exactly that bug — a mis-filtered
 * codemod left eight dead links inside the renamed route tree (the workspace
 * index redirect, the agent Chat button, post-create navigation, four
 * deep-link redirects), invisible to `tsc` and to every component test. So the
 * source itself is the assertion. Grep, not import: the point is to see
 * strings no module graph reaches.
 */
const WEB_SRC = new URL("../..", import.meta.url).pathname;
const DEAD_PREFIX = "/p/";

const deadPrefixHits = (): string[] => {
  let out = "";
  try {
    out = execFileSync(
      "grep",
      [
        "-rInF",
        "--include=*.ts",
        "--include=*.tsx",
        DEAD_PREFIX,
        `${WEB_SRC}src`,
      ],
      { encoding: "utf8" },
    );
  } catch (err) {
    // grep exits 1 with no output when nothing matches — the good case.
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && !e.stdout?.trim()) return [];
    throw err;
  }
  return (
    out
      .trim()
      .split("\n")
      .filter(Boolean)
      // This file necessarily contains the pattern it forbids.
      .filter((line) => !line.includes("dead-url-prefix.test.ts"))
  );
};

describe("the retired dashboard URL prefix", () => {
  it("appears nowhere in the web source — no route serves it", () => {
    // MUTATION-PROOF: reintroduce one dead link and this fails.
    expect(deadPrefixHits()).toEqual([]);
  });
});
