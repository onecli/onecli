// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AwsRoleConnectPage from "./aws-role-connect-page";

/**
 * The regression this suite exists for: the External ID box used to be filled
 * only when the popup URL carried `?orgId=`, so opening AWS Role from a
 * WORKSPACE Connections page (which passes `workspaceId` and no `orgId`)
 * rendered a permanently blank field and a connect that failed server-side.
 *
 * The id now comes from an org-scoped endpoint the server resolves from the
 * request's own scope, so no URL param is involved at all.
 */
const mocks = vi.hoisted(() => ({
  getExternalId: vi.fn<() => Promise<{ externalId: string }>>(),
}));

vi.mock("@/lib/api", () => ({
  awsExternalId: { get: mocks.getExternalId },
}));

// The popup carries its tenancy in the QUERY STRING, so the page must read it
// from there — `apiFetch` cannot derive it from `/app-connect/aws-role`.
const search = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => search.params,
}));

// The connect form itself posts to the API and pulls in the whole client
// graph; this suite is about the trust-policy panel, so render it alone.
vi.mock("@/app/(connect)/app-connect/_components/connect-flow", () => ({
  ConnectFlow: ({
    preContent,
    workspaceId,
    orgId,
  }: {
    preContent?: ReactNode;
    workspaceId?: string;
    orgId?: string;
  }) => (
    <div>
      {/* The connect POST authenticates with these; without them the submit
          401s on cloud exactly like the read did. */}
      <span data-testid="flow-workspace">{workspaceId ?? "-"}</span>
      <span data-testid="flow-org">{orgId ?? "-"}</span>
      {preContent}
    </div>
  ),
}));

const renderPage = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<AwsRoleConnectPage />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
};

describe("AwsRoleConnectPage", () => {
  beforeEach(() => {
    mocks.getExternalId.mockReset();
    search.params = new URLSearchParams();
  });

  it("shows the org's external ID with no orgId in the URL", async () => {
    mocks.getExternalId.mockResolvedValue({ externalId: "onecli-abc-123" });

    renderPage();

    expect(await screen.findByText("onecli-abc-123")).toBeTruthy();
  });

  it("passes the WORKSPACE scope from the query string", async () => {
    // The dev-deploy regression: the popup's pathname is
    // /app-connect/aws-role, so apiFetch derives no tenancy header and a cloud
    // session resolves to no tenant at all (401). The scope has to be read
    // from the query string and passed explicitly.
    search.params = new URLSearchParams({ workspaceId: "ws-1" });
    mocks.getExternalId.mockResolvedValue({ externalId: "onecli-abc-123" });

    renderPage();

    await screen.findByText("onecli-abc-123");
    expect(mocks.getExternalId).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      orgId: undefined,
    });
    // …and onward to the connect POST, which needs the same scope.
    expect(screen.getByTestId("flow-workspace").textContent).toBe("ws-1");
  });

  it("passes the ORG scope from the query string", async () => {
    search.params = new URLSearchParams({ orgId: "org-1" });
    mocks.getExternalId.mockResolvedValue({ externalId: "onecli-abc-123" });

    renderPage();

    await screen.findByText("onecli-abc-123");
    expect(mocks.getExternalId).toHaveBeenCalledWith({
      workspaceId: undefined,
      orgId: "org-1",
    });
    expect(screen.getByTestId("flow-org").textContent).toBe("org-1");
  });

  it("says so when the external ID cannot be loaded", async () => {
    // The old failure mode rendered an empty box forever, which reads as a
    // broken page. Anything is better than nothing here.
    mocks.getExternalId.mockRejectedValue(new Error("nope"));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Unavailable")).toBeTruthy();
    });
    expect(
      screen.getByText(/Could not load your organization's external ID/),
    ).toBeTruthy();
  });

  it("names the copy control for screen readers", async () => {
    // The button's visible text is the id itself, which says nothing about
    // what activating it does.
    mocks.getExternalId.mockResolvedValue({ externalId: "onecli-abc-123" });

    renderPage();

    await screen.findByText("onecli-abc-123");
    expect(screen.getByLabelText("Copy External ID")).toBeTruthy();
    expect(screen.getByLabelText("Copy OneCLI Account ID")).toBeTruthy();
  });

  it("asks the server for the id exactly once", async () => {
    mocks.getExternalId.mockResolvedValue({ externalId: "onecli-abc-123" });

    renderPage();

    await screen.findByText("onecli-abc-123");
    expect(mocks.getExternalId).toHaveBeenCalledTimes(1);
  });
});
