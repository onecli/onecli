// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  GITHUB_AUTHORIZED_APPS_URL,
  githubOrgAdminMessage,
} from "@onecli/api/lib/github-org-access";
import { GitHubOrgAccessNotice } from "./github-org-access-notice";

describe("GitHubOrgAccessNotice", () => {
  it("approval: links to GitHub's request page and copies the admin message", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    render(
      <GitHubOrgAccessNotice
        issue={{ org: "acme", reason: "approval_required" }}
      />,
    );

    expect(screen.getByText(/Waiting for admin approval/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Request Access/ }),
    ).toHaveAttribute("href", GITHUB_AUTHORIZED_APPS_URL);

    await user.click(
      screen.getByRole("button", {
        name: "Copy a message asking an owner of acme to approve OneCLI",
      }),
    );
    expect(writeText).toHaveBeenCalledWith(githubOrgAdminMessage("acme"));
    expect(screen.getByText("Copied")).toBeInTheDocument();
    expect(screen.getByText("Message copied")).toHaveAttribute(
      "aria-live",
      "polite",
    );
    // No reconnect for approval: reconnecting cannot grant it.
    expect(screen.queryByRole("button", { name: /Reconnect/ })).toBeNull();
  });

  it("sso: links to the org's SSO page and offers reconnect", async () => {
    const onReconnect = vi.fn();
    render(
      <GitHubOrgAccessNotice
        issue={{ org: "acme", reason: "sso_required" }}
        onReconnect={onReconnect}
      />,
    );

    expect(screen.getByText(/SSO sign-in needed/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Sign In to acme SSO/ }),
    ).toHaveAttribute("href", "https://github.com/orgs/acme/sso");
    await userEvent.click(screen.getByRole("button", { name: /Reconnect/ }));
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it("sso: hides reconnect where the connection can't be re-authorized here", () => {
    render(
      <GitHubOrgAccessNotice issue={{ org: "acme", reason: "sso_required" }} />,
    );
    expect(screen.queryByRole("button", { name: /Reconnect/ })).toBeNull();
  });
});
