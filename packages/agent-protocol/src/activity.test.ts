import { describe, expect, it } from "vitest";
import {
  ACTIVITY_TEXT_MAX,
  activityForReasoning,
  activityForTool,
} from "./activity";

/**
 * The activity line is the ONE derivation two surfaces share (web chat, Slack
 * work status), and it renders UNTRUSTED sandbox text. These pin the two
 * properties that matter: it reads like a status, and it can never become
 * anything but a short single line.
 */
describe("activityForReasoning", () => {
  it("takes the first line — the intent, not the digression", () => {
    // Models open a thinking block with what they are about to do, then
    // ramble. The opening line is the only part that reads like a status.
    expect(
      activityForReasoning(
        "Architecting two distinct characters\nThen I need to consider the arc, and whether the ending earns itself…",
      ),
    ).toBe("Architecting two distinct characters");
  });

  it("skips leading blank lines rather than returning nothing", () => {
    expect(activityForReasoning("\n\n  \nChecking the CI logs")).toBe(
      "Checking the CI logs",
    );
  });

  it("strips markdown furniture — this is a status row, not a document", () => {
    expect(activityForReasoning("## **Reviewing** the `diff`")).toBe(
      "Reviewing the diff",
    );
    expect(activityForReasoning("- Reading the config")).toBe(
      "Reading the config",
    );
    expect(activityForReasoning("> Considering the tradeoff")).toBe(
      "Considering the tradeoff",
    );
  });

  it("strips control characters and Unicode line separators", () => {
    // U+2028 would otherwise split a Slack status row; control bytes are
    // rejected outright by the transcript store.
    expect(activityForReasoning("Check\u0007ing\u2028 the logs")).toBe(
      "Checking the logs",
    );
  });

  it("bounds a long line at a word boundary, with an ellipsis", () => {
    const line = activityForReasoning(`${"alpha beta ".repeat(30)}omega`);
    expect(line).not.toBeNull();
    expect(line!.length).toBeLessThanOrEqual(ACTIVITY_TEXT_MAX + 1);
    expect(line!.endsWith("…")).toBe(true);
    // Cut BETWEEN words, not through one.
    expect(line).not.toMatch(/alp…$/);
  });

  it("hard-cuts an unbroken word rather than running past the bound", () => {
    const line = activityForReasoning("x".repeat(500));
    expect(line!.length).toBe(ACTIVITY_TEXT_MAX + 1);
    expect(line!.endsWith("…")).toBe(true);
  });

  it("never ends on a split surrogate pair", () => {
    // Cutting mid-emoji leaves a lone high surrogate, which renders as a
    // replacement character on both surfaces.
    const line = activityForReasoning("😀".repeat(200));
    expect(/[\uD800-\uDBFF]$/.test(line!.slice(0, -1))).toBe(false);
  });

  it("returns null when there is nothing to say", () => {
    // Null and "" render differently: null keeps the previous line, an empty
    // string would blank the row.
    expect(activityForReasoning("")).toBeNull();
    expect(activityForReasoning("   \n\t\n  ")).toBeNull();
    expect(activityForReasoning("***")).toBeNull();
  });
});

describe("activityForTool", () => {
  it("names the activity, not the API call", () => {
    expect(activityForTool("bash")).toBe("Running a command");
    expect(activityForTool("read")).toBe("Reading a file");
    expect(activityForTool("webfetch")).toBe("Fetching a page");
  });

  it("sees through the platform's MCP prefix", () => {
    // The prefix is plumbing; a reader should get the same phrase either way.
    expect(activityForTool("mcp__onecli__process_status")).toBe(
      "Checking background work",
    );
    expect(activityForTool("process_status")).toBe("Checking background work");
  });

  it("is case-insensitive", () => {
    expect(activityForTool("BASH")).toBe("Running a command");
  });

  it("NEVER echoes an unknown tool's raw name", () => {
    // MCP servers define their own tool names, so the name is
    // sandbox-controlled text. A generic phrase beats putting it on screen.
    expect(activityForTool("some_third_party_tool")).toBe("Using a tool");
    expect(activityForTool("<script>alert(1)</script>")).toBe("Using a tool");
    expect(activityForTool("mcp__evil__" + "x".repeat(500))).toBe(
      "Using a tool",
    );
  });
});
