// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TestConnection } from "./test-connection";
import { testConnection } from "@/lib/api/connection-test";

vi.mock("@/lib/api/connection-test", () => ({ testConnection: vi.fn() }));
const api = vi.mocked(testConnection);
beforeEach(() => {
  api.mockReset();
  window.history.replaceState({}, "", "/");
});
const setup = (hasElevatedAccess = false) => {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <TestConnection
        connectionId="stored"
        hasElevatedAccess={hasElevatedAccess}
        scope={{ kind: "workspace", workspaceId: "w" }}
      />
    </QueryClientProvider>,
  );
  return invalidate;
};
describe("TestConnection", () => {
  it("selects explicit organization scope on the organization page", async () => {
    window.history.replaceState(
      {},
      "",
      "/org/selected-org/settings/global-connections",
    );
    api.mockResolvedValue({ ok: true, superuser: false });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TestConnection connectionId="shared" pageScope="organization" />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText("Connection verified");
    expect(api.mock.calls[0]?.[0]).toEqual({
      connectionId: "shared",
      scope: { kind: "organization", organizationId: "selected-org" },
    });
  });
  it("keeps workspace-owned connections in the acting workspace scope", async () => {
    window.history.replaceState({}, "", "/w/selected-workspace/connections");
    api.mockResolvedValue({ ok: true, superuser: false });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TestConnection connectionId="workspace-owned" />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText("Connection verified");
    expect(api.mock.calls[0]?.[0]).toEqual({
      connectionId: "workspace-owned",
      scope: { kind: "workspace", workspaceId: "selected-workspace" },
    });
  });
  it("replaces icon and disables the button while pending, then announces success and refreshes metadata", async () => {
    let finish: ((value: { ok: true; superuser: boolean }) => void) | undefined;
    api.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const invalidate = setup();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    const pending = await screen.findByRole("button", { name: "Testing..." });
    expect(pending.hasAttribute("disabled")).toBe(true);
    expect(pending.querySelector(".animate-spin")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "Checking connection",
    );
    finish?.({ ok: true, superuser: true });
    await screen.findByText("Connection verified");
    expect(screen.getByRole("note").textContent).toContain(
      "Elevated database access",
    );
    expect(invalidate).toHaveBeenCalled();
    expect(api).toHaveBeenCalledWith(
      {
        connectionId: "stored",
        scope: { kind: "workspace", workspaceId: "w" },
      },
      expect.anything(),
    );
  });
  it("does not repeat the card's existing privilege warning after a successful test", async () => {
    api.mockResolvedValue({ ok: true, superuser: true });
    setup(true);
    const action = screen.getByRole("button", { name: "Test connection" });
    expect(action.getAttribute("data-variant")).toBe("ghost");
    expect(action.querySelector("svg")).toBeNull();
    fireEvent.click(action);
    await screen.findByText("Connection verified");
    expect(screen.queryByRole("note")).toBeNull();
  });
  it("announces an error without showing stale success and invalidates metadata", async () => {
    api.mockRejectedValue(new Error("Login refused"));
    const invalidate = setup();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Login refused"),
    );
    const alert = screen.getByRole("alert");
    expect(alert.querySelector("p")?.textContent).toBe("Could not connect");
    expect(alert.querySelectorAll("p")).toHaveLength(2);
    expect(alert.querySelector(".text-destructive")).toBeNull();
    expect(screen.queryByText("Connection verified")).toBeNull();
    expect(invalidate).toHaveBeenCalled();
  });
});
