// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { HowRulesEvaluated } from "./how-rules-evaluated";

/**
 * The policy console's "How rules are evaluated" popover describes the
 * two-level model: org guardrails first, then workspace rules, and the
 * stricter verdict wins.
 */
describe("HowRulesEvaluated", () => {
  it("explains org guardrails, then workspace rules, stricter wins", async () => {
    render(<HowRulesEvaluated />);
    await userEvent.click(
      screen.getByRole("button", { name: "How rules are evaluated" }),
    );

    const steps = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(steps).toEqual([
      "Organization guardrails are checked top-down. The first rule that matches is the org’s decision.",
      "Workspace rules are checked the same way, in their listed order.",
      "The stricter of the two wins: Block beats Allow, and requiring approval beats a rate limit.",
      "If no rule at a level matches, that level’s Default Rule gives its verdict, and the stricter verdict wins.",
    ]);
    expect(
      screen.getByText(
        "Only one rule ever decides: rate limits and approvals don’t stack.",
      ),
    ).toBeTruthy();
  });
});
