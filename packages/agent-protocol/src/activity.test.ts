import { describe, expect, it } from "vitest";
import {
  ACTIVITY_TEXT_MAX,
  REASONING_TAIL_MAX,
  activityForReasoning,
  activityForReasoningStream,
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

describe("activityForReasoningStream", () => {
  /** A reasoning stream as the transcript holds it: the deltas glued back
   *  together, read after each delta lands. */
  const captionsWhileStreaming = (deltas: string[]): (string | null)[] => {
    let acc = "";
    return deltas.map((delta) => {
      acc += delta;
      return activityForReasoningStream(acc);
    });
  };

  it("never shows a fragment however the stream is cut (the bug this fixes)", () => {
    // The exact shape from the field: a summary heading then prose, cut by
    // network batches at arbitrary characters. Per-delta derivation showed
    // "d memory first, then review…" and "ngs must be picked up before any wo".
    const reasoning =
      "**Laying out the plan for the recurring check**\n\n" +
      "I need to read memory first, then review my open PRs for new CI failures or review comments. " +
      "If the lock is held by another run I should stop, plus open findings must be picked up before any work is chosen. " +
      "**Choosing the top finding**\n\nThen I can pick the top finding and validate it.";
    const cuts = [62, 48, 97, 35, 110, 71, 44];
    const deltas: string[] = [];
    for (let i = 0, k = 0; i < reasoning.length; k++) {
      const n = cuts[k % cuts.length]!;
      deltas.push(reasoning.slice(i, i + n));
      i += n;
    }
    const captions = captionsWhileStreaming(deltas).filter(
      (c): c is string => c !== null,
    );
    expect(new Set(captions)).toEqual(
      new Set([
        "Laying out the plan for the recurring check",
        "Choosing the top finding",
      ]),
    );
  });

  it("prefers the latest heading over the prose under it", () => {
    expect(
      activityForReasoningStream(
        "**Reading the logs**\nThe build failed twice.\n**Checking the config**\nIt sets ",
      ),
    ).toBe("Checking the config");
  });

  it("falls back to the latest COMPLETE sentence when there is no heading", () => {
    expect(
      activityForReasoningStream(
        "First I will check the CI logs. Then I compare the two runs. Next I",
      ),
    ).toBe("Then I compare the two runs.");
  });

  it("does not read a heading that is still being written", () => {
    // `**Checking the con` has no closing marks yet: the earlier, finished
    // heading stands.
    expect(
      activityForReasoningStream("**Reading the logs**\n**Checking the con"),
    ).toBe("Reading the logs");
  });

  it("returns null until a whole thought exists, so the previous caption stands", () => {
    expect(activityForReasoningStream("")).toBeNull();
    expect(activityForReasoningStream("I need to check")).toBeNull();
    expect(activityForReasoningStream("**Plann")).toBeNull();
  });

  it("only reads the tail of a very long stream", () => {
    const long = `${"Filler sentence here. ".repeat(500)}**Final step**\n`;
    expect(long.length).toBeGreaterThan(REASONING_TAIL_MAX);
    expect(activityForReasoningStream(long)).toBe("Final step");
  });

  it("never reads the cut-off back half of a sentence at the tail's start", () => {
    // The tail slice lands mid-word: "…ntence here." must not be a caption.
    const long = `${"word ".repeat(1_000)}tail end. Last whole one.`;
    expect(activityForReasoningStream(long)).toBe("Last whole one.");
    expect(activityForReasoningStream(`${"x".repeat(5_000)}`)).toBeNull();
  });

  it("does not mistake inline emphasis for a heading", () => {
    expect(
      activityForReasoningStream("This is **important** to check. Then"),
    ).toBe("This is important to check.");
  });

  it("keeps a dotted token (a version, a file name) inside its sentence", () => {
    // A dot only ends a sentence when whitespace follows it: "2.7.1" and
    // "config.prod.yaml" are words, never the start of a caption.
    expect(activityForReasoningStream("Version 2.7.1 is pinned. Next I")).toBe(
      "Version 2.7.1 is pinned.",
    );
    expect(
      activityForReasoningStream("Reading config.prod.yaml now. Next I"),
    ).toBe("Reading config.prod.yaml now.");
  });

  it("reads a closed status line that has no period", () => {
    // Short reasoning lines often skip the period; once the newline closes
    // the line, it is a whole thought. The open line after it is not.
    expect(activityForReasoningStream("Reviewing the diff\nNext I")).toBe(
      "Reviewing the diff",
    );
    expect(activityForReasoningStream("Reviewing the di")).toBeNull();
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
  it("names the conversation for changes and thread posts elsewhere", () => {
    const there = '{"conversation":"#x","messageId":"1.2"}';
    expect(
      activityForToolCall("edit_my_reply", there, false, out("edited")),
    ).toBe("Edited a message in #x");
    expect(
      activityForToolCall("delete_my_reply", there, false, out("deleted")),
    ).toBe("Deleted a message in #x");
    expect(
      activityForToolCall("edit_my_reply", there, false, {
        output: "no",
        isError: true,
      }),
    ).toBe("Couldn't edit its reply");
    expect(activityForToolCall("delete_my_reply", there, true)).toBe(
      "Deleting its reply",
    );
    expect(
      activityForToolCall(
        "send_message",
        '{"to":"#x","text":"hi","thread":"1.2"}',
        false,
        out("sent"),
      ),
    ).toBe("Posted in a thread in #x");
  });
  it("a change elsewhere that waits on the person never claims it happened", () => {
    const there = '{"conversation":"#x","messageId":"1.2"}';
    expect(
      activityForToolCall("delete_my_reply", there, false, out("held")),
    ).toBe("Waiting for your approval: delete a message in #x");
    expect(
      activityForToolCall("edit_my_reply", there, false, out("held")),
    ).toBe("Waiting for your approval: edit a message in #x");
    expect(
      activityForToolCall("edit_my_reply", there, false, out("needs_access")),
    ).toBe("Needs your input: edit a message in #x");
  });
  it("while running, the result is not consulted", () => {
    expect(activityForToolCall("send_as_me", asMe, true, out("held"))).toBe(
      "Sending as you to @Sam",
    );
  });
});

describe("activityForToolCall: send_message with files", () => {
  const withFiles = JSON.stringify({
    to: "#proj-reports",
    text: "here",
    files: ["report.csv"],
  });
  const out = (status: string) => ({ output: JSON.stringify({ status }) });
  it("names the file count and the target, and never says Sent while held", () => {
    expect(activityForToolCall("send_message", withFiles, true)).toBe(
      "Sending 1 file to #proj-reports",
    );
    expect(
      activityForToolCall("send_message", withFiles, false, out("held")),
    ).toBe("Waiting for approval: send 1 file to #proj-reports");
    expect(
      activityForToolCall("send_message", withFiles, false, out("sent")),
    ).toBe("Sent 1 file to #proj-reports");
    expect(
      activityForToolCall("send_message", withFiles, false, {
        output: "nope",
        isError: true,
      }),
    ).toBe("Couldn't send 1 file to #proj-reports");
  });
});
