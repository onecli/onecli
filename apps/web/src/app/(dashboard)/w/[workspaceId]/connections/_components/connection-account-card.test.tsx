// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AccountCardConnection } from "./account-card-connection";

// Unit boundary: the dialog brings its own data graph (closed here).
vi.mock("@/lib/components/policy-reflect", () => ({
  ConnectionAgentsReflection: () => null,
}));

const { ConnectionAccountCard } = await import("./connection-account-card");

const READ_FILES = {
  scope: "https://www.googleapis.com/auth/drive.readonly",
  name: "Read files",
  description: "View and download all your Drive files",
};

const connection = (
  overrides: Partial<AccountCardConnection> = {},
): AccountCardConnection => ({
  id: "conn-1",
  provider: "google-drive",
  label: "alex@example.com",
  status: "connected",
  scopes: [],
  scope: null,
  metadata: null,
  connectedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const renderCard = (
  conn: ReturnType<typeof connection>,
  onReconnect = vi.fn(),
) => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ConnectionAccountCard
        connection={conn}
        appName="Google Drive"
        onReconnect={onReconnect}
      />
    </QueryClientProvider>,
  );
  return onReconnect;
};

describe("ConnectionAccountCard: missing permissions", () => {
  it("flags the account yellow, names what's missing, and reconnects it", async () => {
    const user = userEvent.setup();
    const onReconnect = renderCard(
      connection({ missingPermissions: [READ_FILES] }),
    );
    expect(
      screen.getByText(/Connected · Missing permissions/),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("“Read files”");
    await user.click(
      screen.getByRole("button", { name: /Reconnect to grant/ }),
    );
    expect(onReconnect).toHaveBeenCalledWith("conn-1");
  });

  it("lets a refused login win: one problem at a time", () => {
    renderCard(
      connection({
        missingPermissions: [READ_FILES],
        reauthRequiredAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    expect(screen.getByText("Needs reconnect")).toBeInTheDocument();
    expect(screen.queryByText(/Missing permissions/)).toBeNull();
  });

  it("shows nothing extra for a full grant", () => {
    renderCard(connection({ missingPermissions: [] }));
    expect(screen.queryByText(/Missing permissions/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
