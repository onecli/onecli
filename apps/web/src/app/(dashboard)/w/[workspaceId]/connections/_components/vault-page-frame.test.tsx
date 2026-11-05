// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { describe, expect, it, vi } from "vitest";
import BitwardenPage from "../vaults/bitwarden/page";
import OnePasswordPage from "../vaults/onepassword/page";

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws-1/connections/vaults/bitwarden",
}));

// The setup flows own their data fetching; these tests cover the page frame.
vi.mock("./bitwarden-setup", () => ({
  BitwardenSetup: () => <div data-testid="setup">bitwarden setup</div>,
}));
vi.mock("./onepassword-setup", () => ({
  OnePasswordSetup: () => <div data-testid="setup">1password setup</div>,
}));

describe.each<{
  name: string;
  Page: ComponentType;
  description: string;
  setup: string;
}>([
  {
    name: "Bitwarden",
    Page: BitwardenPage,
    description:
      "Fetch credentials on-demand from your Bitwarden vault. Nothing is stored on the server.",
    setup: "bitwarden setup",
  },
  {
    name: "1Password",
    Page: OnePasswordPage,
    description:
      "Resolve secrets on-demand from 1Password using a service account. Nothing is stored on the server.",
    setup: "1password setup",
  },
])("$name vault page", ({ name, Page, description, setup }) => {
  it("links back to the Vaults tab of the current workspace", () => {
    render(<Page />);
    expect(screen.getByRole("link", { name: "Vaults" })).toHaveAttribute(
      "href",
      "/w/ws-1/connections/vaults",
    );
  });

  it("shows the provider title with a Beta badge and its description", () => {
    render(<Page />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent(name);
    expect(
      within(heading.parentElement as HTMLElement).getByText("Beta"),
    ).toBeInTheDocument();
    expect(screen.getByText(description)).toBeInTheDocument();
  });

  it("renders the provider's setup flow below the header", () => {
    render(<Page />);
    expect(screen.getByTestId("setup")).toHaveTextContent(setup);
  });
});
