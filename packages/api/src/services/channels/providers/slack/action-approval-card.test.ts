import { describe, expect, it } from "vitest";
import {
  ACTION_APPROVAL_DECISIONS,
  actionApprovalCardBlocks,
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

  it("the click vocabulary maps the three buttons and nothing else", () => {
    expect(ACTION_APPROVAL_DECISIONS).toEqual({
      action_approve: "approve",
      action_approve_always: "approve_always",
      action_reject: "reject",
    });
  });

  it("offers the always-allow button only when the action declares the hook", () => {
    const withOffer = actionApprovalCardBlocks({
      approvalId: "ap-1",
      agentName: "Donna",
      summary: 'send @Tomer: "hi"',
      offerAlwaysAllow: true,
    });
    const actions = withOffer.find(
      (b) => (b as { type?: string }).type === "actions",
    ) as { elements: { action_id: string }[] };
    expect(actions.elements.map((e) => e.action_id)).toEqual([
      "action_approve",
      "action_approve_always",
      "action_reject",
    ]);

    const without = actionApprovalCardBlocks({
      approvalId: "ap-1",
      agentName: "Donna",
      summary: "do the thing",
    });
    const plain = without.find(
      (b) => (b as { type?: string }).type === "actions",
    ) as { elements: { action_id: string }[] };
    expect(plain.elements.map((e) => e.action_id)).toEqual([
      "action_approve",
      "action_reject",
    ]);
  });
});
