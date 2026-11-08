import { describe, expect, it } from "vitest";
import {
  ACTION_APPROVAL_DECISIONS,
  actionApprovalCardBlocks,
  actionApprovalClickOf,
  settledActionCardText,
} from "./action-approval-card";

/**
 * The action-approval card's trust rules — the reach-card discipline
 * applied to the new card kind: dynamic fields escaped, leading directive
 * tokens neutralized, button values carrying only the opaque approval id.
 */

const flat = (blocks: unknown[]): string => JSON.stringify(blocks);

describe("actionApprovalCardBlocks", () => {
  it("escapes Slack syntax in the summary - a summary can never mint a mention", () => {
    const rendered = flat(
      actionApprovalCardBlocks({
        approvalId: "a-1",
        agentName: "Donna",
        summary: "message <@U123> and <!channel> now",
      }),
    );
    expect(rendered).not.toContain("<@U123>");
    expect(rendered).not.toContain("<!channel>");
    expect(rendered).toContain("&lt;@U123&gt;");
  });

  it("neutralizes a leading slash-command shape", () => {
    const rendered = flat(
      actionApprovalCardBlocks({
        approvalId: "a-2",
        agentName: "Donna",
        summary: "/msg everyone hello",
      }),
    );
    expect(rendered).toContain("\u2060/msg");
  });

  it("buttons carry ONLY the opaque approval id", () => {
    const blocks = actionApprovalCardBlocks({
      approvalId: "a-3",
      agentName: "Donna",
      summary: "send the report",
    }) as { type: string; elements?: { value?: string }[] }[];
    const actions = blocks.find((b) => b.type === "actions");
    expect(actions?.elements?.map((e) => e.value)).toEqual(["a-3", "a-3"]);
  });

  it("is just the ask and the buttons: no header, no how-it-works paragraph", () => {
    const blocks = actionApprovalCardBlocks({
      approvalId: "a-4",
      agentName: "Donna",
      summary: 'send @Dana: "hi"',
    }) as { type: string; text?: { text: string } }[];
    expect(blocks.map((b) => b.type)).toEqual(["section", "actions"]);
    expect(blocks[0]?.text?.text).toBe('*Donna* asks: send @Dana: "hi"');
  });

  it("the click vocabulary maps the two buttons, plus the retired always-allow id as an approve", () => {
    expect(ACTION_APPROVAL_DECISIONS).toEqual({
      action_approve: "approve",
      action_approve_always: "approve",
      action_reject: "reject",
    });
  });

  it("a standing question words the same two buttons Always allow / Never", () => {
    const buttons = (standingChoice: boolean) =>
      (
        actionApprovalCardBlocks({
          approvalId: "ap-1",
          agentName: "Donna",
          summary: 'message Sam from now on? First message: "hi"',
          standingChoice,
        }).find((b) => (b as { type?: string }).type === "actions") as {
          elements: { action_id: string; text: { text: string } }[];
        }
      ).elements.map((e) => [e.action_id, e.text.text]);
    expect(buttons(true)).toEqual([
      ["action_approve", "Always allow"],
      ["action_reject", "Never"],
    ]);
    expect(buttons(false)).toEqual([
      ["action_approve", "Approve"],
      ["action_reject", "Reject"],
    ]);
  });

  it("a settled standing question says the answer its buttons used, a one-off says Approved / Rejected", () => {
    const settled = (outcome: string, standing: boolean) =>
      settledActionCardText({
        summary: "message Sam from now on?",
        outcome,
        decidedByName: "Morgan",
        standing,
      });
    expect(settled("executed", true)).toBe(
      "\u2705 Always allowed by Morgan: message Sam from now on?",
    );
    expect(settled("rejected", true)).toBe(
      "\u26d4 Never by Morgan: message Sam from now on?",
    );
    expect(settled("executed", false)).toBe(
      "\u2705 Approved by Morgan: message Sam from now on?",
    );
    expect(settled("rejected", false)).toBe(
      "\u26d4 Rejected by Morgan: message Sam from now on?",
    );
  });
});

describe("actionApprovalCardBlocks link card", () => {
  it("renders the note and ONE URL button, no decide buttons", () => {
    const rendered = flat(
      actionApprovalCardBlocks({
        approvalId: "a-9",
        agentName: "Helper",
        summary: "Connect your Slack so Helper can send as you",
        link: {
          url: "https://app.example/w/ws/agents/a/contacts?connect=slack",
          label: "Connect your Slack",
          note: "Connecting happens in OneCLI.",
        },
      }),
    );
    expect(rendered).toContain("?connect=slack");
    expect(rendered).toContain("Connect your Slack");
    expect(rendered).toContain("Connecting happens in OneCLI.");
    expect(rendered).not.toContain("action_approve");
    expect(rendered).not.toContain('"value":"a-9"');
  });
});

describe("a blocked contact's card", () => {
  it("renders Allow / Don't send only; no Allow once, Always allow or Keep blocked", () => {
    const rendered = JSON.stringify(
      actionApprovalCardBlocks({
        approvalId: "a-1",
        agentName: "Helper",
        summary: "Let Helper message Sam?",
        choices: [{ value: "allow", label: "Allow" }],
      }),
    );
    expect(rendered).toContain('"text":"Allow"');
    expect(rendered).toContain(`"text":"Don't send"`);
    for (const gone of ["Allow once", "Always allow", "Keep blocked"]) {
      expect(rendered).not.toContain(gone);
    }
    expect(actionApprovalClickOf("action_choose__allow")).toEqual({
      decision: "approve",
      choice: "allow",
    });
  });
});

describe("button text fits Slack's 75-character limit", () => {
  type Block = {
    type: string;
    elements?: { type: string; text?: { text: string } }[];
  };
  const buttonTexts = (blocks: unknown): string[] =>
    (blocks as Block[])
      .flatMap((b) => (b.type === "actions" ? (b.elements ?? []) : []))
      .filter((e) => e.type === "button")
      .map((e) => e.text?.text ?? "");

  it("a long agent name in a choice button is clamped with an ellipsis; short labels are untouched", () => {
    const longName = "A".repeat(120);
    const texts = buttonTexts(
      actionApprovalCardBlocks({
        approvalId: "a-1",
        agentName: longName,
        summary: `How should ${longName} message @Sam?`,
        choices: [
          { value: "you", label: "As me" },
          { value: "agent", label: `As ${longName}` },
        ],
      }),
    );
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(75);
    const clamped = texts.find((t) => t.startsWith("As AAA"));
    expect(clamped).toHaveLength(75);
    expect(clamped!.endsWith("…")).toBe(true);
    expect(texts).toContain("As me");
  });

  it("a long link label is clamped too", () => {
    const [text] = buttonTexts(
      actionApprovalCardBlocks({
        approvalId: "a-2",
        agentName: "Helper",
        summary: "Connect your Slack",
        link: {
          url: "https://app.example/w/ws/agents/a/contacts?connect=slack",
          label: "Connect ".repeat(20),
          note: "Connecting happens in OneCLI.",
        },
      }),
    );
    expect(text!.length).toBe(75);
  });
});
