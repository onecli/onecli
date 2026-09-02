// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { KeyHealthBadge } from "./key-health-badge";

const AT = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

describe("KeyHealthBadge", () => {
  it.each([
    [429, "Rate limited"],
    [401, "Key rejected"],
    [403, "Key rejected"],
    [402, "Billing issue"],
  ])("labels HTTP %i as %s, with recency", (status, label) => {
    render(<KeyHealthBadge type="anthropic" lastError={{ status, at: AT }} />);
    expect(
      screen.getByRole("button", { name: `${label} · 3h ago` }),
    ).toBeInTheDocument();
  });

  it("opens the explanation with a keyboard-reachable provider link (auth → keys page)", async () => {
    render(
      <KeyHealthBadge type="anthropic" lastError={{ status: 401, at: AT }} />,
    );

    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/HTTP 401/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Manage Anthropic keys/ });
    expect(link).toHaveAttribute(
      "href",
      "https://platform.claude.com/settings/keys",
    );
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("routes non-auth failures to the provider's billing page", async () => {
    render(
      <KeyHealthBadge type="openai" lastError={{ status: 429, at: AT }} />,
    );

    await userEvent.click(screen.getByRole("button"));
    expect(
      screen.getByRole("link", { name: /OpenAI billing & limits/ }),
    ).toHaveAttribute(
      "href",
      "https://platform.openai.com/settings/organization/billing/overview",
    );
  });

  it("shows no link for a provider it cannot name", async () => {
    render(
      <KeyHealthBadge type="mystery" lastError={{ status: 401, at: AT }} />,
    );

    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/HTTP 401/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
