// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InheritedConnectionCard } from "./inherited-connection-card";

// Unit boundary: the agent rows bring their own data graph.
vi.mock("./connection-agent-rows", () => ({
  ConnectionAgentRows: () => null,
}));

const orgShared = (metadata: Record<string, unknown> | null) => ({
  id: "conn-org",
  provider: "github",
  label: "octo",
  scope: "organization",
  status: "connected",
  scopes: [],
  metadata,
  connectedAt: "2026-10-01T00:00:00Z",
});

describe("InheritedConnectionCard", () => {
  it("shows an organization's refusal of an org-shared account, read-only", () => {
    render(
      <InheritedConnectionCard
        connection={orgShared({
          githubOrgAccess: { acme: { reason: "sso_required" } },
        })}
      />,
    );
    expect(screen.getByText("1 GitHub org needs access")).toBeInTheDocument();
    expect(screen.getByText(/SSO sign-in needed/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Sign In to acme SSO/ }),
    ).toBeInTheDocument();
    // Only an organization admin can re-authorize an org-shared account.
    expect(screen.queryByRole("button", { name: /Reconnect/ })).toBeNull();
  });

  it("shows nothing extra without a refusal", () => {
    render(<InheritedConnectionCard connection={orgShared(null)} />);
    expect(screen.queryByText(/needs access/)).toBeNull();
  });

  // Reconnecting with the other level replaces the account, so the card
  // must say which kind of token the account holds.
  it("names the access level of an app that offers more than one", () => {
    render(
      <InheritedConnectionCard
        connection={{
          ...orgShared({ accessLevel: "user" }),
          provider: "attio",
        }}
      />,
    );
    expect(screen.getByText(/Personal access/)).toBeInTheDocument();
  });

  it("names a GitHub organization as GitHub's, never as a OneCLI organization", () => {
    render(
      <InheritedConnectionCard
        connection={{
          ...orgShared({ accountType: "Organization" }),
          provider: "github-app",
        }}
      />,
    );
    expect(screen.getByText(/GitHub organization/)).toBeInTheDocument();
    expect(screen.queryByText(/^Organization$/)).toBeNull();
  });

  it("names no level for a connection made before it was recorded", () => {
    render(
      <InheritedConnectionCard
        connection={{ ...orgShared(null), provider: "attio" }}
      />,
    );
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText(/Workspace access|Personal access/)).toBeNull();
  });
});
