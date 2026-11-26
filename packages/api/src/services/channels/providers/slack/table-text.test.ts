import { decodeSlackTokens } from "@onecli/channels/slack";
import { describe, expect, it } from "vitest";

import { interpretSlackEvent } from "./interpret";
import {
  MAX_TABLE_TEXT_CHARS,
  TABLE_TRUNCATED_MARKER,
  messageText,
} from "./table-text";

/**
 * A table pasted into Slack reaches the agent. Slack keeps a pasted table
 * out of `text` (it rides in `attachments[].blocks`), so a request like "add
 * them to the campaign" used to arrive without the rows it pointed at.
 */

const raw = (text: string) => ({ type: "raw_text", text });
const rich = (...elements: unknown[]) => ({
  type: "rich_text",
  elements: [{ type: "rich_text_section", elements }],
});
const table = (rows: unknown[][]) => ({ type: "table", rows });

/** Made-up contacts in the shape of a pasted spreadsheet (ids are fake
 * Salesforce-shaped values). */
const CONTACTS = [
  ["Alex Kim", "Acme Demo", "003QO00000AbCdEFG1", "No"],
  ["Sam Rivera", "Globex Demo", "003QO00000AbCdEFG2", "No"],
  ["Jo Park", "Initech Demo", "003QO00000AbCdEFG3", "Yes"],
];
const CONTACTS_TABLE = table(CONTACTS.map((row) => row.map(raw)));
const CONTACTS_TEXT = CONTACTS.map((row) => row.join(" | ")).join("\n");

const SENTENCE = 'add them to the "Spring Outreach (demo)" campaign';

/** The prose the speaker typed, as the client sends it beside the table. */
const PROSE = {
  type: "rich_text",
  elements: [
    {
      type: "rich_text_section",
      elements: [{ type: "text", text: SENTENCE }],
    },
  ],
};

/** The inbound shape of a pasted table (desktop client): prose in
 * `blocks`, the table in `attachments[].blocks`. */
const PASTED = {
  text: SENTENCE,
  blocks: [PROSE],
  attachments: [
    { id: 1, blocks: [CONTACTS_TABLE], fallback: "[no preview available]" },
  ],
};

const BOT = "UBOTSELF";
const CTX = { botUserId: BOT };

/** The text of a direct or group call. */
const textOf = (call: ReturnType<typeof interpretSlackEvent>): string => {
  if (call.door !== "direct" && call.door !== "group") {
    throw new Error(`unexpected door ${call.door}`);
  }
  return call.text;
};

describe("messageText", () => {
  it("appends a pasted table (attachments[].blocks), one row per line", () => {
    expect(messageText(PASTED)).toBe(`${SENTENCE}\n\n${CONTACTS_TEXT}`);
  });

  it("reads an app-posted table from top-level blocks", () => {
    expect(
      messageText({ text: SENTENCE, blocks: [PROSE, CONTACTS_TABLE] }),
    ).toBe(`${SENTENCE}\n\n${CONTACTS_TEXT}`);
  });

  it("carries a table sent with no typed text", () => {
    expect(messageText({ attachments: [{ blocks: [CONTACTS_TABLE] }] })).toBe(
      CONTACTS_TEXT,
    );
  });

  it("leaves a message without a table untouched", () => {
    expect(messageText({ text: SENTENCE, blocks: [PROSE] })).toBe(SENTENCE);
    expect(messageText({})).toBe("");
    // A link-unfurl attachment (no blocks) is not a table.
    expect(
      messageText({
        text: SENTENCE,
        attachments: [{ title: "x", text: "y" }, null, 3],
      }),
    ).toBe(SENTENCE);
  });

  it("writes rich-text cells in the grammar of `text`: real mentions become tokens", () => {
    const cells = table([
      [
        rich(
          { type: "text", text: "Owner " },
          { type: "user", user_id: "U0AAA" },
          { type: "text", text: " in " },
          { type: "channel", channel_id: "C0BBB" },
        ),
        rich(
          { type: "link", url: "https://example.com", text: "site" },
          { type: "emoji", name: "white_check_mark" },
        ),
        rich(
          { type: "usergroup", usergroup_id: "S0CCC" },
          { type: "broadcast", range: "here" },
        ),
      ],
    ]);
    expect(messageText({ blocks: [cells] })).toBe(
      "Owner <@U0AAA> in <#C0BBB> | <https://example.com|site>:white_check_mark: | <!subteam^S0CCC><!here>",
    );
  });

  it("escapes literal cell text, so a cell can only LOOK like a mention", async () => {
    // Slack escapes `&`, `<`, `>` in `text`; table cells arrive unescaped.
    const cells = table([
      [raw("<!channel> ping <@U0ADMIN1>"), raw("AT&T <b>")],
      [rich({ type: "text", text: "<#C0PRIV1|secret>" })],
    ]);
    const text = messageText({ text: "fyi", blocks: [cells] });
    expect(text).toBe(
      "fyi\n\n&lt;!channel&gt; ping &lt;@U0ADMIN1&gt; | AT&amp;T &lt;b&gt;\n&lt;#C0PRIV1|secret&gt;",
    );
    // Through the real inbound decoder: the literal text survives as text,
    // and no lookup is ever made for the forged ids.
    const looked: string[] = [];
    const decoded = await decodeSlackTokens(
      text,
      (id) => {
        looked.push(id);
        return "Org Admin";
      },
      (id) => {
        looked.push(id);
        return "secret";
      },
    );
    expect(decoded).toBe(
      "fyi\n\n<!channel> ping <@U0ADMIN1> | AT&T <b>\n<#C0PRIV1|secret>",
    );
    expect(looked).toEqual([]);
  });

  it("never lets an element field smuggle grammar into a token", () => {
    const cells = table([
      [
        rich(
          { type: "user", user_id: "U1>pwn<!channel" },
          { type: "broadcast", range: "everyone>" },
          { type: "emoji", name: "x:<@U0ADMIN1>" },
          { type: "link", url: "https://x.example/?a=1&b=<2>", text: "a|b" },
        ),
      ],
    ]);
    expect(messageText({ blocks: [cells] })).toBe(
      ":x:&lt;@U0ADMIN1&gt;:<https://x.example/?a=1&amp;b=&lt;2&gt;|a|b>",
    );
  });

  it("separates a cell's paragraphs and list items instead of gluing them", () => {
    const cell = {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_section",
          elements: [{ type: "text", text: "Steps:" }],
        },
        {
          type: "rich_text_list",
          style: "bullet",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "call" }],
            },
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "email" }],
            },
          ],
        },
      ],
    };
    expect(messageText({ blocks: [table([[cell, raw("x")]])] })).toBe(
      "Steps: call email | x",
    );
  });

  it("keeps a row on one line when a cell holds line breaks", () => {
    expect(
      messageText({
        blocks: [table([[raw("line one\r\n\n  line two"), raw("x")]])],
      }),
    ).toBe("line one line two | x");
  });

  it("shows a number cell as Slack displays it, falling back to its value", () => {
    expect(
      messageText({
        blocks: [
          table([
            [
              { type: "raw_number", value: 1234.5, text: "$1,234.50" },
              { type: "raw_number", value: 42 },
            ],
          ]),
        ],
      }),
    ).toBe("$1,234.50 | 42");
  });

  it("reads a date by its fallback, and any element by its text", () => {
    const cells = table([
      [
        rich({
          type: "date",
          timestamp: 1790904362,
          format: "{date_short}",
          fallback: "Oct 2, 2026",
        }),
        rich({ type: "file", file_id: "F0AAA", text: "Q3 plan.pdf" }),
      ],
    ]);
    expect(messageText({ blocks: [cells] })).toBe("Oct 2, 2026 | Q3 plan.pdf");
  });

  it("skips malformed blocks and attachments, never throwing", () => {
    expect(
      messageText({
        text: SENTENCE,
        blocks: [{ type: "table", rows: [[{ nope: true }]] }, "garbage", 3],
        attachments: [
          "garbage",
          { blocks: "nope" },
          { blocks: [{ type: "table" }, { type: "table", rows: "x" }] },
        ],
      }),
    ).toBe(SENTENCE);
    expect(messageText({ blocks: "not an array" })).toBe("");
  });

  it("survives a hostile, deeply nested cell", () => {
    // An unbounded recursive walk overflowed the stack here, which would
    // have thrown out of the interpreter and lost the whole message.
    let element: Record<string, unknown> = { type: "text", text: "deep" };
    for (let i = 0; i < 5000; i++) {
      element = { type: "rich_text_section", elements: [element] };
    }
    const cells = table([[{ type: "rich_text", elements: [element] }]]);
    expect(messageText({ blocks: [cells, table([[raw("ok")]])] })).toBe("ok");
  });

  it("caps rows and cells at Slack's table limits", () => {
    const big = table(
      Array.from({ length: 150 }, () =>
        Array.from({ length: 30 }, () => raw("c")),
      ),
    );
    const lines = messageText({ blocks: [big] }).split("\n");
    expect(lines).toHaveLength(100);
    expect(lines[0]!.split(" | ")).toHaveLength(20);
  });

  it("bounds the rendered tables and says so", () => {
    const wide = "x".repeat(400);
    const big = table(
      Array.from({ length: 100 }, () =>
        Array.from({ length: 20 }, () => raw(wide)),
      ),
    );
    const out = messageText({ text: "hi", blocks: [big] });
    expect(out.endsWith(`\n${TABLE_TRUNCATED_MARKER}`)).toBe(true);
    expect(out).toHaveLength(
      "hi\n\n".length +
        MAX_TABLE_TEXT_CHARS +
        1 +
        TABLE_TRUNCATED_MARKER.length,
    );
  });
});

describe("a pasted table reaches the agent on every door", () => {
  it("a DM", () => {
    const call = interpretSlackEvent(
      {
        type: "message",
        channel: "D0001",
        channel_type: "im",
        user: "U1111",
        ts: "1111.0001",
        ...PASTED,
      },
      CTX,
    );
    expect(call.door).toBe("direct");
    expect(textOf(call)).toBe(`${SENTENCE}\n\n${CONTACTS_TEXT}`);
  });

  it("an @mention in a channel", () => {
    const call = interpretSlackEvent(
      {
        type: "app_mention",
        channel: "C9999",
        user: "U1111",
        ts: "2222.0001",
        ...PASTED,
        text: `<@${BOT}> ${SENTENCE}`,
      },
      CTX,
    );
    expect(call).toMatchObject({
      door: "group",
      text: `<@${BOT}> ${SENTENCE}\n\n${CONTACTS_TEXT}`,
      typedText: `<@${BOT}> ${SENTENCE}`,
    });
  });

  it("a thread follow-up and an overheard channel message", () => {
    const base = {
      type: "message",
      channel: "C9999",
      channel_type: "channel",
      user: "U1111",
      ts: "2222.0002",
      ...PASTED,
    };
    for (const event of [{ ...base, thread_ts: "2222.0000" }, base]) {
      expect(interpretSlackEvent(event, CTX)).toMatchObject({
        door: "group",
        text: `${SENTENCE}\n\n${CONTACTS_TEXT}`,
        // Addressing reads what was typed: a name in a table is data.
        typedText: SENTENCE,
      });
    }
  });

  it("a malformed blocks or attachments field never drops the message", () => {
    for (const extra of [{ blocks: null }, { attachments: {} }]) {
      const call = interpretSlackEvent(
        {
          type: "message",
          channel: "D0001",
          channel_type: "im",
          user: "U1111",
          text: SENTENCE,
          ts: "1111.0002",
          ...extra,
        },
        CTX,
      );
      expect(call.door).toBe("direct");
      expect(textOf(call)).toBe(SENTENCE);
    }
  });

  it("a bot mention inside a table cell is not a mention (the twin rule reads typed text)", () => {
    const call = interpretSlackEvent(
      {
        type: "message",
        channel: "C9999",
        channel_type: "channel",
        user: "U1111",
        text: "see table",
        blocks: [table([[rich({ type: "user", user_id: BOT })]])],
        ts: "2222.0003",
        thread_ts: "2222.0000",
      },
      CTX,
    );
    // Not dropped as a mention twin: Slack sends no app_mention for a
    // mention that exists only in a table cell.
    expect(call.door).toBe("group");
  });
});
