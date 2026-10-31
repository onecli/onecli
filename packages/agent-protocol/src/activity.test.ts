import { describe, expect, it } from "vitest";
import {
  ACTIVITY_TEXT_MAX,
  activityForReasoning,
  activityForToolCall,
  activityForTool,
  bareToolName,
  toolKind,
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
    expect(activityForTool("mcp__onecli__message_agent")).toBe(
      "Messaging another agent",
    );
    expect(activityForTool("mcp__onecli__complete_task")).toBe(
      "Reporting back",
    );
  });

  it("bareToolName strips exactly the harness MCP prefix", () => {
    expect(bareToolName("mcp__onecli__process_status")).toBe("process_status");
    expect(bareToolName("mcp__other__x_y")).toBe("x_y");
    expect(bareToolName("bash")).toBe("bash");
    // Only a leading prefix: a bare name that happens to contain the shape
    // is left alone.
    expect(bareToolName("foo_mcp__onecli__bar")).toBe("foo_mcp__onecli__bar");
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

describe("a finished tool call's line", () => {
  const done = (name: string) =>
    activityForToolCall(name, undefined, false, { output: "" });

  it("is the past tense of the same phrase", () => {
    expect(done("bash")).toBe("Ran a command");
    expect(done("read")).toBe("Read a file");
    expect(done("mcp__onecli__websearch")).toBe("Searched the web");
    expect(done("mcp__onecli__swarm")).toBe("Coordinated helpers");
    // The platform's channel tools, seen in real agent turns.
    expect(done("mcp__onecli__find_recipient")).toBe("Looked someone up");
    expect(activityForTool("mcp__onecli__send_message")).toBe(
      "Sending a message",
    );
    expect(done("mcp__onecli__send_file")).toBe("Sent a file");
    expect(activityForTool("mcp__onecli__preview_expose")).toBe(
      "Asking for a preview link",
    );
  });

  it("NEVER echoes an unknown tool's raw name", () => {
    expect(done("<img src=x onerror=alert(1)>")).toBe("Used a tool");
  });
});

describe("toolKind", () => {
  it("names what a countable tool works on, through the MCP prefix", () => {
    expect(toolKind("bash")).toBe("command");
    expect(toolKind("READ")).toBe("read");
    expect(toolKind("apply_patch")).toBe("edit");
    expect(toolKind("mcp__onecli__webfetch")).toBe("fetch");
    expect(toolKind("agentgrep")).toBe("search");
  });

  it("is undefined for a tool that is not one countable kind", () => {
    expect(toolKind("todo")).toBeUndefined();
    expect(toolKind("some_third_party_tool")).toBeUndefined();
  });
});

describe("activityForToolCall: act-as-you lines name the conversation", () => {
  it("send_as_me reads Sent as you to <conversation>", () => {
    expect(
      activityForToolCall(
        "mcp__onecli__send_as_me",
        JSON.stringify({ conversation: "#general", text: "hi" }),
        false,
      ),
    ).toBe("Sent as you to #general");
    expect(
      activityForToolCall(
        "send_as_me",
        JSON.stringify({ conversation: "Sam" }),
        true,
      ),
    ).toBe("Sending as you to Sam");
  });
  it("edit and delete read in <conversation>", () => {
    const input = JSON.stringify({ conversation: "#eng", messageId: "1" });
    expect(activityForToolCall("edit_my_message", input, false)).toBe(
      "Edited a message sent as you in #eng",
    );
    expect(activityForToolCall("delete_my_message", input, false)).toBe(
      "Asked to delete a message sent as you in #eng",
    );
  });
  it("no input or another tool: the plain phrase, never 'someone'", () => {
    expect(activityForToolCall("send_as_me", undefined, false)).toBe(
      "Sent as you",
    );
    expect(activityForToolCall("send_message", '{"to":"x"}', false)).toBe(
      "Sent a message",
    );
  });
});

describe("activityForToolCall: a finished send says what really happened", () => {
  const asMe = JSON.stringify({ conversation: "@Sam", text: "hi" });
  const toSam = JSON.stringify({ to: "@Sam", text: "hi" });
  const out = (status: string) => ({ output: JSON.stringify({ status }) });
  it("sent reads Sent as you to X", () => {
    expect(activityForToolCall("send_as_me", asMe, false, out("sent"))).toBe(
      "Sent as you to @Sam",
    );
  });
  it("held, needs_access, needs_choice and an error never say Sent", () => {
    expect(activityForToolCall("send_as_me", asMe, false, out("held"))).toBe(
      "Waiting for your approval: send as you to @Sam",
    );
    expect(
      activityForToolCall("send_as_me", asMe, false, out("needs_access")),
    ).toBe("Needs your input: send to @Sam");
    expect(
      activityForToolCall("send_message", toSam, false, out("needs_choice")),
    ).toBe("Needs your input: send to @Sam");
    expect(
      activityForToolCall("send_message", toSam, false, {
        output: "boom",
        isError: true,
      }),
    ).toBe("Couldn't send to @Sam");
    expect(
      activityForToolCall("send_message", toSam, false, out("not_sent")),
    ).toBe("Not sent to @Sam");
  });
  it("edit and delete follow their outcome too", () => {
    const input = JSON.stringify({ conversation: "#eng", messageId: "1" });
    expect(
      activityForToolCall("delete_my_message", input, false, out("held")),
    ).toBe("Waiting for your approval: delete a message in #eng");
    expect(
      activityForToolCall("edit_my_message", input, false, {
        isError: true,
      }),
    ).toBe("Couldn't edit a message in #eng");
  });
  it("the agent's own-reply changes never claim a change that failed", () => {
    const failed = { output: "refused", isError: true };
    expect(
      activityForToolCall(
        "mcp__onecli__edit_my_reply",
        "{}",
        false,
        out("edited"),
      ),
    ).toBe("Edited its reply");
    expect(activityForToolCall("edit_my_reply", "{}", false, failed)).toBe(
      "Couldn't edit its reply",
    );
    expect(activityForToolCall("delete_my_reply", "{}", false, failed)).toBe(
      "Couldn't delete its reply",
    );
    expect(activityForToolCall("delete_my_reply", "{}", true, failed)).toBe(
      "Deleting its reply",
    );
    expect(
      activityForToolCall("list_my_replies", undefined, false, { output: "" }),
    ).toBe("Looked at its own replies");
  });
  it("while running, the result is not consulted", () => {
    expect(activityForToolCall("send_as_me", asMe, true, out("held"))).toBe(
      "Sending as you to @Sam",
    );
  });
});
