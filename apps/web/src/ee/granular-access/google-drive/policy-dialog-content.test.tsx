// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Drive picker is an expandable tree: each folder shows its direct
 * subfolder/file counts and opens until it has no subfolders. A selection is
 * stored as the folder-ID CHAIN from the top down — the exact shape the
 * gateway verifies against Drive's live parent links.
 */

const counts = (subfolderCount: number, fileCount: number) => ({
  subfolderCount,
  fileCount,
  countCapped: false,
});
const listings: Record<string, Record<string, unknown>[]> = {
  "": [
    { id: "F1", name: "Clients", kind: "folder", ...counts(1, 3) },
    { id: "SD", name: "Team Drive", kind: "sharedDrive", ...counts(0, 0) },
    { id: "SH", name: "Inbox", kind: "shared", ...counts(1, 0) },
    {
      id: "F4",
      name: "Archive",
      kind: "folder",
      subfolderCount: 0,
      fileCount: 1000,
      countCapped: true,
    },
  ],
  F1: [{ id: "F2", name: "Acme", kind: "folder", ...counts(1, 12) }],
  F2: [{ id: "F3", name: "Contracts", kind: "folder", ...counts(0, 4) }],
  // Counted only up to the first page: no subfolders seen there, but more
  // children exist, so it must stay expandable.
  F4: [{ id: "F5", name: "Deep", kind: "folder", ...counts(0, 0) }],
  SH: [{ id: "SH2", name: "Batch 1", kind: "folder", ...counts(0, 3) }],
};
const fetched: string[] = [];
/** Whether the names lookup (saved chains → names) has resolved. */
let namesKnown = true;
/** Saved folder IDs the dialog asked the names lookup for (enabled only). */
const namesLookedUp: string[] = [];

vi.mock("./use-google-drive-folders", () => ({
  useGoogleDriveFolders: (_c: string, parentId: string, enabled: boolean) => {
    if (enabled) fetched.push(parentId);
    return {
      data: enabled ? (listings[parentId] ?? []) : [],
      isPending: false,
      isError: false,
    };
  },
  useGoogleDriveFolderNames: (_c: string, ids: string[], enabled = true) => {
    if (enabled && ids.length > 0) namesLookedUp.push(...ids);
    return {
      data:
        enabled && namesKnown
          ? { F1: "Clients", F2: "Acme", F3: "Contracts" }
          : {},
    };
  },
}));
vi.mock("@/lib/user-plan", () => ({
  getCurrentPlan: async () => "team",
}));
vi.mock("@/ee/billing/_components/upgrade-to-team-button", () => ({
  UpgradeToTeamButton: () => null,
}));

const { GoogleDrivePolicyDialogContent } =
  await import("./policy-dialog-content");
const { childSummary } = await import("./folder-row");

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.scrollIntoView ??= () => {};
});

type Policy = Record<string, unknown> | null;
const queryClient = new QueryClient();
const onPolicyChange = vi.fn();
const ui = (policy: Policy, orgBoundary: Policy = null) => (
  <QueryClientProvider client={queryClient}>
    <GoogleDrivePolicyDialogContent
      connectionId="c1"
      metadata={{}}
      policy={policy}
      orgBoundary={orgBoundary}
      onPolicyChange={onPolicyChange}
      onSave={() => {}}
      onCancel={() => {}}
    />
  </QueryClientProvider>
);
const setup = (policy: Policy, orgBoundary: Policy = null) => ({
  onPolicyChange,
  ...render(ui(policy, orgBoundary)),
});

const expand = (user: ReturnType<typeof userEvent.setup>, name: string) =>
  user.click(screen.getByRole("button", { name: `Expand ${name}` }));

describe("GoogleDrivePolicyDialogContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onPolicyChange.mockReset();
    queryClient.clear();
    fetched.length = 0;
    namesLookedUp.length = 0;
    namesKnown = true;
  });

  it("opens folder by folder until one has no subfolders, with counts at every level", async () => {
    const user = userEvent.setup({ delay: null });
    setup({ driveFolders: [] });
    expect(screen.getByText("1 folder · 3 files")).toBeInTheDocument();
    expect(screen.getByText("Empty")).toBeInTheDocument();
    // Only the top level is fetched until something is opened.
    expect(fetched).toEqual([""]);

    await expand(user, "Clients");
    expect(screen.getByText("1 folder · 12 files")).toBeInTheDocument();
    await expand(user, "Acme");
    expect(screen.getByText("4 files")).toBeInTheDocument();
    // The leaf can't be opened further: no expand control for it, and it is
    // never listed.
    expect(
      screen.queryByRole("button", { name: "Expand Contracts" }),
    ).not.toBeInTheDocument();
    expect(fetched).not.toContain("F3");
    // A folder with nothing inside can't be opened either.
    expect(
      screen.queryByRole("button", { name: "Expand Team Drive" }),
    ).not.toBeInTheDocument();
  });

  it("stores the full chain of ids for a deeply nested folder", async () => {
    const user = userEvent.setup({ delay: null });
    const { onPolicyChange } = setup({ driveFolders: [] });
    await expand(user, "Clients");
    await expand(user, "Acme");
    await user.click(screen.getByRole("checkbox", { name: "Contracts" }));
    expect(onPolicyChange).toHaveBeenLastCalledWith({
      driveFolders: ["F1/F2/F3"],
    });
  });

  it("names a picked chain from the browse, before the names lookup", async () => {
    namesKnown = false;
    const user = userEvent.setup({ delay: null });
    // Feed each change back in, as the real dialog does.
    const { onPolicyChange, rerender } = setup({ driveFolders: [] });
    onPolicyChange.mockImplementation((policy) => rerender(ui(policy)));
    await expand(user, "Clients");
    await expand(user, "Acme");
    await user.click(screen.getByRole("checkbox", { name: "Contracts" }));
    expect(
      screen.getByRole("button", {
        name: "Remove Clients / Acme / Contracts",
      }),
    ).toBeInTheDocument();
  });

  it("collapses an opened folder", async () => {
    const user = userEvent.setup({ delay: null });
    setup({ driveFolders: [] });
    await expand(user, "Clients");
    expect(screen.getByText("Acme")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Collapse Clients" }));
    expect(screen.queryByText("Acme")).not.toBeInTheDocument();
  });

  it("selects a top-level shared drive by its id", async () => {
    const user = userEvent.setup({ delay: null });
    const { onPolicyChange } = setup({ driveFolders: [] });
    await user.click(screen.getByRole("checkbox", { name: "Team Drive" }));
    expect(onPolicyChange).toHaveBeenLastCalledWith({ driveFolders: ["SD"] });
  });

  it("labels saved chains with names and clears to all on last removal", async () => {
    const user = userEvent.setup({ delay: null });
    const { onPolicyChange } = setup({ driveFolders: ["F1/F2"] });
    await user.click(
      screen.getByRole("button", { name: "Remove Clients / Acme" }),
    );
    expect(onPolicyChange).toHaveBeenLastCalledWith(null);
  });

  it("disables folders outside the organization's boundary", () => {
    setup({ driveFolders: [] }, { driveFolders: ["SD"] });
    expect(screen.getByRole("checkbox", { name: "Clients" })).toBeDisabled();
    expect(
      screen.getByRole("checkbox", { name: "Team Drive" }),
    ).not.toBeDisabled();
  });

  it("shows descendants of a selected folder as covered and locked", async () => {
    const user = userEvent.setup({ delay: null });
    setup({ driveFolders: ["F1"] });
    await expand(user, "Clients");
    await expand(user, "Acme");
    for (const name of ["Acme", "Contracts"]) {
      const box = screen.getByRole("checkbox", { name });
      expect(box).toBeChecked();
      expect(box).toBeDisabled();
    }
  });

  it("summarizes counts, including unknown and capped", () => {
    expect(childSummary(counts(2, 1))).toBe("2 folders · 1 file");
    expect(childSummary(counts(0, 0))).toBe("Empty");
    expect(
      childSummary({
        subfolderCount: null,
        fileCount: null,
        countCapped: false,
      }),
    ).toBeNull();
    // A capped count is a lower bound: whatever the first page held, "+".
    expect(
      childSummary({ subfolderCount: 5, fileCount: 995, countCapped: true }),
    ).toBe("1000+ items");
    expect(
      childSummary({ subfolderCount: 0, fileCount: 870, countCapped: true }),
    ).toBe("870+ items");
  });

  it("keeps a folder with a capped count expandable", async () => {
    const user = userEvent.setup({ delay: null });
    setup({ driveFolders: [] });
    expect(screen.getByText("1000+ items")).toBeInTheDocument();
    await expand(user, "Archive");
    expect(screen.getByText("Deep")).toBeInTheDocument();
  });

  it("warns and offers a reconnect instead of listing when 'Read files' wasn't granted", async () => {
    const user = userEvent.setup({ delay: null });
    const onReconnect = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <GoogleDrivePolicyDialogContent
          connectionId="c1"
          metadata={{}}
          policy={{ driveFolders: ["F1/F2"] }}
          onPolicyChange={onPolicyChange}
          onSave={() => {}}
          onCancel={() => {}}
          missingPermissions={[
            {
              scope: "https://www.googleapis.com/auth/drive.readonly",
              name: "Read files",
              description: "View and download all your Drive files",
            },
          ]}
          onReconnect={onReconnect}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Missing permissions");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "can't list the folders in this Drive",
    );
    // Neither doomed request goes out: the listing nor the saved-names lookup
    // (the server refuses both without Drive read access).
    expect(fetched).toEqual([]);
    expect(namesLookedUp).toEqual([]);
    await user.click(
      screen.getByRole("button", { name: /Reconnect to grant/ }),
    );
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it("ignores missing permissions the listing doesn't need", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <GoogleDrivePolicyDialogContent
          connectionId="c1"
          metadata={{}}
          policy={{ driveFolders: [] }}
          onPolicyChange={onPolicyChange}
          onSave={() => {}}
          onCancel={() => {}}
          missingPermissions={[
            {
              scope: "https://www.googleapis.com/auth/drive.file",
              name: "Manage app files",
              description: "Create and edit files opened or created by OneCLI",
            },
          ]}
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetched).toEqual([""]);
  });

  it("drills into a Shared-with-me folder and selects it as its own chain head", async () => {
    const user = userEvent.setup({ delay: null });
    setup({ driveFolders: [] });
    await expand(user, "Inbox");
    expect(screen.getByText("Batch 1")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Batch 1" }));
    expect(onPolicyChange).toHaveBeenLastCalledWith({
      driveFolders: ["SH/SH2"],
    });
  });
});
