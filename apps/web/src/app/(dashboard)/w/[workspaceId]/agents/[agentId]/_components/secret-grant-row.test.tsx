// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { grants } from "@/lib/api";
import type { Secret } from "@/lib/api";
import { SecretGrantRow } from "./secret-grant-row";

// The badge's own behavior (labels, popover, fix links) is pinned by
// key-health-badge.test.tsx; the unit here is the ROW — grant toggling, the
// org lock, the edit door, and whether the badge mounts at all.

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    grants: {
      ...actual.grants,
      attachSecret: vi.fn().mockResolvedValue({}),
      detachSecret: vi.fn().mockResolvedValue(undefined),
    },
  };
});

const makeSecret = (overrides: Partial<Secret> = {}): Secret =>
  ({
    id: "sec-1",
    name: "Anthropic key",
    type: "anthropic",
    typeLabel: "Anthropic",
    hostPattern: "api.anthropic.com",
    scope: null,
    createdAt: "2026-08-01T00:00:00Z",
    lastError: null,
    ...overrides,
  }) as Secret;

const renderRow = (
  props: Partial<Parameters<typeof SecretGrantRow>[0]> = {},
) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(
    <SecretGrantRow
      agentId="agent-1"
      secret={makeSecret()}
      granted={false}
      orgGranted={false}
      credentialStatus={undefined}
      {...props}
    />,
    { wrapper },
  );
};

describe("SecretGrantRow", () => {
  afterEach(() => {
    vi.mocked(grants.attachSecret).mockClear();
    vi.mocked(grants.detachSecret).mockClear();
  });

  it("mounts the health badge only when the key carries a lastError", () => {
    const { unmount } = renderRow();
    expect(screen.queryByText(/Key rejected/)).toBeNull();
    unmount();

    renderRow({
      secret: makeSecret({
        lastError: {
          status: 401,
          at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        },
      }),
    });
    expect(screen.getByText(/Key rejected/)).toBeInTheDocument();
  });

  it("shows the edit pencil only when the surface provides an editor", async () => {
    const { unmount } = renderRow();
    expect(
      screen.queryByRole("button", { name: "Edit Anthropic key" }),
    ).toBeNull();
    unmount();

    const onEdit = vi.fn();
    renderRow({ onEdit });
    await userEvent.click(
      screen.getByRole("button", { name: "Edit Anthropic key" }),
    );
    expect(onEdit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sec-1" }),
    );
  });

  it("locks an org-rule-granted key ON — checked, disabled, attributed", () => {
    renderRow({ orgGranted: true });
    const toggle = screen.getByRole("switch", { name: "Detach Anthropic key" });
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
    expect(
      screen.getByText("Granted by your organization"),
    ).toBeInTheDocument();
  });

  it("attaches on toggle-on and detaches on toggle-off", async () => {
    const { unmount } = renderRow();
    await userEvent.click(
      screen.getByRole("switch", { name: "Attach Anthropic key" }),
    );
    await waitFor(() =>
      expect(grants.attachSecret).toHaveBeenCalledWith("agent-1", "sec-1"),
    );
    unmount();

    renderRow({ granted: true });
    await userEvent.click(
      screen.getByRole("switch", { name: "Detach Anthropic key" }),
    );
    await waitFor(() =>
      expect(grants.detachSecret).toHaveBeenCalledWith("agent-1", "sec-1"),
    );
  });
});
