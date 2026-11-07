import { describe, expect, it } from "vitest";
import { grantIntentFromChoices, type OtherChoices } from "./grant-intent";
import type { ToolChoice } from "./tri-state-control";

const choices = (
  entries: Record<string, ToolChoice>,
): Record<string, ToolChoice> => entries;

const TOOLS = ["s3_read_objects", "sts_access", "iam_access"];

const ALLOW = choices({
  s3_read_objects: "allow",
  sts_access: "allow",
  iam_access: "allow",
});

/** What the dialog passes once a tool is customized (the default). */
const ASK_BOTH: OtherChoices = { otherReads: "ask", otherWrites: "ask" };
/** What the dialog passes while every tool is Allowed (full access). */
const ALLOW_BOTH: OtherChoices = { otherReads: "allow", otherWrites: "allow" };

describe("grantIntentFromChoices", () => {
  // The regression this file exists for. The previous rule also required the
  // grant to already BE full (`allAllow && wasFull`), which made the change
  // one-way: a customized grant could never return to full, so an all-Allow
  // grid silently saved a per-tool grant instead. The rule takes no prior
  // state, so switching every row back to Allow always lands on full access.
  it("every tool and both catch-alls on Allow saves as full access (no one-way door)", () => {
    expect(grantIntentFromChoices(TOOLS, ALLOW, ALLOW_BOTH)).toEqual({
      access: "full",
    });
  });

  it("keeps a genuine customization custom, carrying both catch-alls", () => {
    expect(
      grantIntentFromChoices(
        TOOLS,
        choices({
          s3_read_objects: "allow",
          sts_access: "ask",
          iam_access: "never",
        }),
        { otherReads: "allow", otherWrites: "never" },
      ),
    ).toEqual({
      access: "custom",
      allow: ["s3_read_objects"],
      ask: ["sts_access"],
      otherReads: "allow",
      otherWrites: "never",
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
        ASK_BOTH,
      ),
    ).toEqual({
      access: "custom",
      allow: ["s3_read_objects", "sts_access"],
      ask: ["iam_access"],
      ...ASK_BOTH,
    });
  });

  it("an all-Allow grid with a catch-all held back is a customization", () => {
    expect(
      grantIntentFromChoices(TOOLS, ALLOW, {
        otherReads: "allow",
        otherWrites: "ask",
      }),
    ).toEqual({
      access: "custom",
      allow: TOOLS,
      ask: [],
      otherReads: "allow",
      otherWrites: "ask",
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
        ASK_BOTH,
      ),
    ).toEqual({ access: "custom", allow: [], ask: [], ...ASK_BOTH });
  });

  it("an empty tool list is never promoted to full", () => {
    // A catalog-less provider has no per-tool axis; vacuous `every` would
    // otherwise widen an empty grid into whole-app access.
    expect(grantIntentFromChoices([], {}, ALLOW_BOTH)).toEqual({
      access: "custom",
      allow: [],
      ask: [],
      ...ALLOW_BOTH,
    });
  });
});
