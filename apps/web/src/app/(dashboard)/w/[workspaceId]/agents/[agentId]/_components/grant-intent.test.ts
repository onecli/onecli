import { describe, expect, it } from "vitest";
import { grantIntentFromChoices } from "./grant-intent";
import type { ToolChoice } from "./tri-state-control";

const choices = (
  entries: Record<string, ToolChoice>,
): Record<string, ToolChoice> => entries;

const TOOLS = ["s3_read_objects", "sts_access", "iam_access"];

describe("grantIntentFromChoices", () => {
  it("every tool on Allow saves as full access", () => {
    expect(
      grantIntentFromChoices(
        TOOLS,
        choices({
          s3_read_objects: "allow",
          sts_access: "allow",
          iam_access: "allow",
        }),
      ),
    ).toEqual({ access: "full" });
  });

  // The regression this file exists for. The previous rule also required the
  // grant to already BE full (`allAllow && wasFull`), which made the change
  // one-way: a customized grant could never return to full, so an all-Allow
  // grid silently saved a per-tool grant instead — visually identical, and
  // narrower in the engine.
  it("returns to full access from a customized grant (no one-way door)", () => {
    // Previously `custom`; the user has now switched every tool back to Allow.
    expect(
      grantIntentFromChoices(
        TOOLS,
        choices({
          s3_read_objects: "allow",
          sts_access: "allow",
          iam_access: "allow",
        }),
      ),
    ).toEqual({ access: "full" });
  });

  it("keeps a genuine customization custom", () => {
    expect(
      grantIntentFromChoices(
        TOOLS,
        choices({
          s3_read_objects: "allow",
          sts_access: "ask",
          iam_access: "never",
        }),
      ),
    ).toEqual({
      access: "custom",
      allow: ["s3_read_objects"],
      ask: ["sts_access"],
    });
  });

  it("a single Ask is enough to stay custom", () => {
    expect(
      grantIntentFromChoices(
        TOOLS,
        choices({
          s3_read_objects: "allow",
          sts_access: "allow",
          iam_access: "ask",
        }),
      ),
    ).toEqual({
      access: "custom",
      allow: ["s3_read_objects", "sts_access"],
      ask: ["iam_access"],
    });
  });

  it("all-Never stays custom and empty (the detach case the caller guards)", () => {
    expect(
      grantIntentFromChoices(
        TOOLS,
        choices({
          s3_read_objects: "never",
          sts_access: "never",
          iam_access: "never",
        }),
      ),
    ).toEqual({ access: "custom", allow: [], ask: [] });
  });

  it("an empty tool list is never promoted to full", () => {
    // A catalog-less provider has no per-tool axis; vacuous `every` would
    // otherwise widen an empty grid into whole-app access.
    expect(grantIntentFromChoices([], {})).toEqual({
      access: "custom",
      allow: [],
      ask: [],
    });
  });
});
