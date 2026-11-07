// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@onecli/ui/components/tooltip";

/**
 * The two dialogs that permanently delete someone's personal workspaces when
 * they leave an organization: removing a member, and leaving. Each lists the
 * workspaces that will be deleted (with the chat apps each uninstalls) and
 * keeps the destructive button locked until every one is acknowledged.
 */

type Workspace = {
  id: string;
  name: string | null;
  channelApps: { provider: string }[];
};

const mocks = vi.hoisted(() => ({
  workspaces: [] as Workspace[],
  removeTeamMember: vi.fn(),
  leaveTeam: vi.fn(),
  getWorkspacesDeletedOnRemove: vi.fn(),
  getWorkspacesDeletedOnLeave: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/team/actions", () => ({
  removeTeamMember: mocks.removeTeamMember,
  leaveTeam: mocks.leaveTeam,
  getWorkspacesDeletedOnRemove: mocks.getWorkspacesDeletedOnRemove,
  getWorkspacesDeletedOnLeave: mocks.getWorkspacesDeletedOnLeave,
}));
vi.mock("@/hooks/use-invitations", () => ({
  useInvitations: () => ({ data: [] }),
  useCancelInvitation: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/hooks/use-org-members", () => ({
  useUpdateOrgMember: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/ee/team/_components/manage-access-dialog", () => ({
  ManageAccessDialog: () => null,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

const { MemberList } = await import("./member-list");
const { LeaveOrgDialog } = await import("./leave-org-dialog");

beforeAll(() => {
  // Radix menus drive their open state through pointer capture and scroll
  // APIs jsdom does not implement.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspaces = [];
  mocks.getWorkspacesDeletedOnRemove.mockImplementation(async () => [
    ...mocks.workspaces,
  ]);
  mocks.getWorkspacesDeletedOnLeave.mockImplementation(async () => [
    ...mocks.workspaces,
  ]);
  mocks.removeTeamMember.mockResolvedValue({ ok: true });
  mocks.leaveTeam.mockResolvedValue({ ok: true });
});

const renderWithClient = (ui: ReactElement) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );

/** The leave dialog is controlled by its parent; this stands in for it. */
const LeaveHarness = () => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open leave
      </button>
      <LeaveOrgDialog open={open} onOpenChange={setOpen} orgName="Acme Org" />
    </>
  );
};

type User = ReturnType<typeof userEvent.setup>;

const surfaces = [
  {
    label: "remove member",
    confirm: "Remove",
    render: () =>
      renderWithClient(
        <MemberList
          members={[
            {
              userId: "me",
              email: "me@example.com",
              name: null,
              role: "owner",
              status: "active",
              ssoExempt: false,
              joinedAt: new Date("2026-01-01"),
            },
            {
              userId: "u-2",
              email: "bob@example.com",
              name: "Bob",
              role: "member",
              status: "active",
              ssoExempt: false,
              joinedAt: new Date("2026-01-01"),
            },
          ]}
          currentUserId="me"
          isAdmin
          orgName="Acme Org"
        />,
      ),
    open: async (user: User) => {
      const row = screen.getByText("bob@example.com").closest("tr")!;
      await user.click(within(row).getByRole("button"));
      await user.click(
        await screen.findByRole("menuitem", { name: "Remove member" }),
      );
    },
    action: () => mocks.removeTeamMember,
  },
  {
    label: "leave organization",
    confirm: "Leave and delete data",
    render: () => renderWithClient(<LeaveHarness />),
    open: async (user: User) => {
      await user.click(screen.getByRole("button", { name: "Open leave" }));
    },
    action: () => mocks.leaveTeam,
  },
];

const APPS_SENTENCE =
  "Their chat apps are uninstalled from your chat workspace, and anyone talking to them there loses the agent.";

describe.each(surfaces)("the $label dialog", (surface) => {
  const openDialog = async (workspaces: Workspace[]) => {
    mocks.workspaces = workspaces;
    const user = userEvent.setup();
    surface.render();
    await surface.open(user);
    const dialog = await screen.findByRole("alertdialog");
    if (workspaces.length > 0) {
      await within(dialog).findAllByRole("checkbox");
    }
    return { user, dialog };
  };

  const confirmButton = (dialog: HTMLElement) =>
    within(dialog).getByRole("button", { name: surface.confirm });

  it("shows no checklist and stays unlocked when nothing is deleted", async () => {
    const { dialog } = await openDialog([]);
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    expect(dialog).not.toHaveTextContent("Acknowledge each workspace");
    expect(dialog).not.toHaveTextContent(APPS_SENTENCE);
    expect(confirmButton(dialog)).toBeEnabled();
  });

  it("lists each workspace with the chat apps it uninstalls", async () => {
    const { dialog } = await openDialog([
      { id: "w-1", name: "Alpha", channelApps: [] },
      { id: "w-2", name: null, channelApps: [{ provider: "slack" }] },
      {
        id: "w-3",
        name: "Gamma",
        channelApps: [{ provider: "slack" }, { provider: "teams" }],
      },
    ]);
    expect(dialog).toHaveTextContent(
      "Acknowledge each workspace that will be permanently deleted:",
    );
    const rows = within(dialog)
      .getAllByRole("checkbox")
      .map((box) => box.closest("label")!.textContent);
    expect(rows).toEqual([
      "Alpha",
      "Untitled· uninstalls 1 chat app",
      "Gamma· uninstalls 2 chat apps",
    ]);
    expect(dialog).toHaveTextContent(APPS_SENTENCE);
  });

  it("leaves out the chat-app warning when no workspace has one", async () => {
    const { dialog } = await openDialog([
      { id: "w-1", name: "Alpha", channelApps: [] },
    ]);
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(1);
    expect(dialog).not.toHaveTextContent(APPS_SENTENCE);
    expect(dialog).not.toHaveTextContent("uninstalls");
  });

  it("unlocks only once every workspace is acknowledged", async () => {
    const { user, dialog } = await openDialog([
      { id: "w-1", name: "Alpha", channelApps: [] },
      { id: "w-2", name: "Beta", channelApps: [] },
    ]);
    const [first, second] = within(dialog).getAllByRole("checkbox");
    expect(confirmButton(dialog)).toBeDisabled();

    await user.click(first!);
    expect(first).toBeChecked();
    expect(confirmButton(dialog)).toBeDisabled();

    // Clicking the row's name toggles its box too (the row is a label).
    await user.click(within(dialog).getByText("Beta"));
    expect(second).toBeChecked();
    expect(confirmButton(dialog)).toBeEnabled();

    await user.click(first!);
    expect(first).not.toBeChecked();
    expect(confirmButton(dialog)).toBeDisabled();

    await user.click(first!);
    await user.click(confirmButton(dialog));
    await waitFor(() => expect(surface.action()).toHaveBeenCalledTimes(1));
  });

  it("forgets acknowledgements when closed and reopened", async () => {
    const { user, dialog } = await openDialog([
      { id: "w-1", name: "Alpha", channelApps: [] },
    ]);
    await user.click(within(dialog).getByRole("checkbox"));
    expect(confirmButton(dialog)).toBeEnabled();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    await surface.open(user);
    const reopened = await screen.findByRole("alertdialog");
    const box = await within(reopened).findByRole("checkbox");
    expect(box).not.toBeChecked();
    expect(confirmButton(reopened)).toBeDisabled();
    expect(surface.action()).not.toHaveBeenCalled();
  });
});
