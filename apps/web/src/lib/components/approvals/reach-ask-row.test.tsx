// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PendingReachAskItem } from "@/lib/api/channel-approvals";
import { ReachAskRow } from "./reach-ask-row";

vi.mock("@/hooks/use-approvals", () => ({
  useDecideChannelReach: () => ({ mutate: vi.fn() }),
}));

const base: PendingReachAskItem = {
  kind: "reach",
  id: "g-1",
  agentId: "a-1",
  agentName: "Donna",
  provider: "slack",
  subjectKind: "space",
  subjectLabel: "#launch-room",
  externalRef: "C0123ABCDEF",
  tenantExternalId: "T0123ABCD",
  createdAt: new Date().toISOString(),
};

const openDetails = () =>
  userEvent.click(screen.getByRole("button", { name: "Details" }));

describe("ReachAskRow details", () => {
  it("is folded until opened, then names the channel answers the row offers and links the channel", async () => {
    render(<ReachAskRow item={base} />);
    expect(screen.queryByText(/stays quiet there/)).toBeNull();

    await openDetails();

    expect(
      screen.getByText(/stays quiet there until you choose/),
    ).toBeDefined();
    // The words of the row's own buttons, nothing retired.
    expect(screen.getByRole("button", { name: "Everyone" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Nobody" })).toBeDefined();
    expect(screen.queryByText(/Teammates only/)).toBeNull();
    const link = screen.getByRole("link", {
      name: /Open the channel in Slack/,
    });
    expect(link.getAttribute("href")).toBe(
      "https://slack.com/app_redirect?channel=C0123ABCDEF&team=T0123ABCD",
    );
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("has no channel link without a tenant id (an older server)", async () => {
    render(<ReachAskRow item={{ ...base, tenantExternalId: undefined }} />);
    await openDetails();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("has no channel link for a provider the build does not know", async () => {
    render(<ReachAskRow item={{ ...base, provider: "teams" }} />);
    await openDetails();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("a person ask explains that Always allow tells them, and links nothing", async () => {
    render(
      <ReachAskRow
        item={{ ...base, subjectKind: "external_user", subjectLabel: "Sam" }}
      />,
    );
    await openDetails();
    expect(screen.getByText(/they get a message saying so/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Always allow" })).toBeDefined();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
