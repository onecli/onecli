// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@onecli/ui/components/tooltip";

/**
 * Deleting a workspace, from both places that offer it: the settings page's
 * danger card and the workspace list's card menu. Both run the same flow:
 * the delete stays locked until the exact workspace id is typed, a confirmed
 * delete closes the dialog before pinning the org and leaving for its
 * workspace list, and a failed one keeps the dialog open with nothing else
 * done.
 */

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  remove: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  setDefaultOrgCookie: vi.fn(),
  orgLanding: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    workspaces: { ...actual.workspaces, remove: mocks.remove },
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth/set-active-scope", () => ({
  setDefaultOrgCookie: mocks.setDefaultOrgCookie,
}));
// Where the org now lands: its first remaining workspace's first agent.
vi.mock("@/lib/dashboard/landing", () => ({ orgLanding: mocks.orgLanding }));
vi.mock("@/lib/plan-gate", () => ({
  usePlanGate: () => ({ guard: () => false }),
}));
vi.mock("@/ee/workspaces/_components/workspace-access-dialog", () => ({
  WorkspaceAccessDialog: () => null,
}));
vi.mock("@/ee/billing/_components/upgrade-to-team-button", () => ({
  UpgradeToTeamButton: () => null,
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));

const { DeleteWorkspaceButton } = await import("./delete-workspace-button");
const { WorkspaceRow } = await import("./workspace-row");

beforeAll(() => {
  // Radix menus drive their open state through pointer capture and scroll
  // APIs jsdom does not implement.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls = [];
  mocks.remove.mockImplementation(async (id: string) => {
    mocks.calls.push(`remove:${id}`);
  });
  mocks.setDefaultOrgCookie.mockImplementation(async (orgId: string) => {
    mocks.calls.push(`cookie:${orgId}`);
  });
  mocks.orgLanding.mockImplementation(
    async (orgId: string) => `/w/ws-next/agents/ag-of-${orgId}/chat`,
  );
  mocks.push.mockImplementation((href: string) => {
    mocks.calls.push(`push:${href}`);
  });
  mocks.refresh.mockImplementation(() => {
    mocks.calls.push("refresh");
  });
});

const renderWithClient = (ui: ReactElement) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );

type Props = { name: string | null; isLastWorkspace?: boolean };

/** Each surface: how to render it and how to open its delete dialog. */
const surfaces = [
  {
    label: "settings danger card",
    // Opened from a menu, focus lands after the menu hands it back, so the
    // input's autofocus is observable only from the plain button.
    autofocus: true,
    render: ({ name, isLastWorkspace = false }: Props) =>
      renderWithClient(
        <DeleteWorkspaceButton
          workspaceId="ws-1"
          workspaceName={name}
          organizationId="org-1"
          isLastWorkspace={isLastWorkspace}
        />,
      ),
    open: async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(
        screen.getByRole("button", { name: "Delete workspace" }),
      );
    },
  },
  {
    label: "workspace list row",
    autofocus: false,
    render: ({ name, isLastWorkspace = false }: Props) =>
      renderWithClient(
        <WorkspaceRow
          id="ws-1"
          name={name}
          agentCount={1}
          resourceCount={2}
          owner={null}
          canManage
          isLastWorkspace={isLastWorkspace}
          organizationId="org-1"
          plan="free"
        />,
      ),
    open: async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(
        screen.getByRole("button", { name: "Workspace actions" }),
      );
      await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    },
  },
];

describe.each(surfaces)("delete workspace from the $label", (surface) => {
  const openDialog = async (props: Props = { name: "Acme" }) => {
    const user = userEvent.setup();
    surface.render(props);
    await surface.open(user);
    const dialog = await screen.findByRole("alertdialog");
    return { user, dialog };
  };

  it("names the workspace and the id to type", async () => {
    const { dialog } = await openDialog();
    expect(
      within(dialog).getByRole("heading", { name: "Delete this workspace?" }),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      "This permanently deletes Acme and all data in it. This cannot be undone.",
    );
    expect(dialog).toHaveTextContent("Type ws-1 to confirm");
    if (surface.autofocus) {
      expect(
        within(dialog).getByPlaceholderText("Enter the workspace ID"),
      ).toHaveFocus();
    }
  });

  it("falls back to 'this workspace' for an unnamed workspace", async () => {
    const { dialog } = await openDialog({ name: null });
    expect(dialog).toHaveTextContent(
      "This permanently deletes this workspace and all data in it.",
    );
  });

  it("unlocks Delete only for the exact id, surrounding spaces ignored", async () => {
    const { user, dialog } = await openDialog();
    const input = within(dialog).getByPlaceholderText("Enter the workspace ID");
    const confirm = within(dialog).getByRole("button", { name: "Delete" });
    expect(confirm).toBeDisabled();

    await user.type(input, "Acme");
    expect(confirm).toBeDisabled();

    await user.clear(input);
    await user.type(input, "ws-");
    expect(confirm).toBeDisabled();

    await user.clear(input);
    await user.type(input, "  ws-1 ");
    expect(confirm).toBeEnabled();
  });

  it("deletes, closes, then pins the org and goes straight to where it lands", async () => {
    const { user, dialog } = await openDialog();
    await user.type(
      within(dialog).getByPlaceholderText("Enter the workspace ID"),
      "ws-1",
    );
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    // One hop: the org's first agent, never its workspaces URL (which
    // would render the shell around its redirect first).
    await waitFor(() =>
      expect(mocks.calls).toEqual([
        "remove:ws-1",
        "cookie:org-1",
        "push:/w/ws-next/agents/ag-of-org-1/chat",
        "refresh",
      ]),
    );
    expect(mocks.orgLanding).toHaveBeenCalledWith("org-1");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("closes the dialog before the cookie write finishes", async () => {
    const cookie = deferred();
    mocks.setDefaultOrgCookie.mockReturnValue(cookie.promise);
    const { user, dialog } = await openDialog();
    await user.type(
      within(dialog).getByPlaceholderText("Enter the workspace ID"),
      "ws-1",
    );
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(mocks.setDefaultOrgCookie).toHaveBeenCalledWith("org-1");
    expect(mocks.push).not.toHaveBeenCalled();
    cookie.resolve();
    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith(
        "/w/ws-next/agents/ag-of-org-1/chat",
      ),
    );
  });

  it("locks the dialog while the delete is in flight", async () => {
    const pending = deferred();
    mocks.remove.mockReturnValue(pending.promise);
    const { user, dialog } = await openDialog();
    await user.type(
      within(dialog).getByPlaceholderText("Enter the workspace ID"),
      "ws-1",
    );
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    const busy = await within(dialog).findByRole("button", {
      name: "Deleting...",
    });
    expect(busy).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    if (surface.label === "settings danger card") {
      // Behind the modal, so hidden from the accessibility tree.
      expect(
        screen.getByRole("button", { name: "Delete workspace", hidden: true }),
      ).toBeDisabled();
    }

    pending.resolve();
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
  });

  it("keeps the dialog open and does nothing else when the delete fails", async () => {
    mocks.remove.mockRejectedValue(new Error("Workspace has running agents"));
    const { user, dialog } = await openDialog();
    await user.type(
      within(dialog).getByPlaceholderText("Enter the workspace ID"),
      "ws-1",
    );
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Workspace has running agents",
      ),
    );
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Delete" }),
    ).toBeEnabled();
    expect(mocks.setDefaultOrgCookie).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("starts over with an empty confirmation after Cancel", async () => {
    const { user, dialog } = await openDialog();
    await user.type(
      within(dialog).getByPlaceholderText("Enter the workspace ID"),
      "ws-1",
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );

    await surface.open(user);
    const reopened = await screen.findByRole("alertdialog");
    expect(
      within(reopened).getByPlaceholderText("Enter the workspace ID"),
    ).toHaveValue("");
    expect(
      within(reopened).getByRole("button", { name: "Delete" }),
    ).toBeDisabled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("starts over with an empty confirmation after Escape", async () => {
    const { user, dialog } = await openDialog();
    await user.type(
      within(dialog).getByPlaceholderText("Enter the workspace ID"),
      "ws-1",
    );
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );

    await surface.open(user);
    const reopened = await screen.findByRole("alertdialog");
    expect(
      within(reopened).getByPlaceholderText("Enter the workspace ID"),
    ).toHaveValue("");
  });
});

describe("delete entry points for the only workspace", () => {
  it("disables the settings button and says why", () => {
    surfaces[0]!.render({ name: "Acme", isLastWorkspace: true });
    expect(
      screen.getByRole("button", { name: "Delete workspace" }),
    ).toBeDisabled();
    expect(
      screen.getByText(
        /You can't delete the only workspace in the organization\./,
      ),
    ).toBeInTheDocument();
  });

  it("disables the row menu's Delete item", async () => {
    const user = userEvent.setup();
    surfaces[1]!.render({ name: "Acme", isLastWorkspace: true });
    await user.click(screen.getByRole("button", { name: "Workspace actions" }));
    expect(
      await screen.findByRole("menuitem", { name: "Delete" }),
    ).toHaveAttribute("data-disabled");
  });
});

describe("workspace list row", () => {
  it("opens the delete dialog without navigating anywhere", async () => {
    const user = userEvent.setup();
    surfaces[1]!.render({ name: "Acme" });
    await surfaces[1]!.open(user);
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
