// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@onecli/ui/components/tooltip";
import type { AgentGrantConnection, Connection } from "@/lib/api";
import { ManagePermissionsDialog } from "./manage-permissions-dialog";

// The dialog's grant intent end to end: what the "Not listed above" rows show
// and what Save writes. The data hooks are mocked at the module boundary; the
// tri-state grid, the section and the intent rule are the real components.

const mutate = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-grants", () => ({
  useSetConnectionGrant: () => ({ mutate, isPending: false }),
}));

vi.mock("@/hooks/use-app-permissions", () => ({
  useAppPermissionDefinitions: () => ({
    isPending: false,
    data: [
      {
        provider: "aws",
        unlisted: "block",
        groups: [
          {
            category: "read",
            tools: [{ id: "s3_read", name: "Read S3", description: "read" }],
          },
          {
            category: "write",
            tools: [{ id: "s3_put", name: "Write S3", description: "write" }],
          },
        ],
      },
    ],
  }),
}));

vi.mock("@/lib/api/policy-visibility", () => ({
  useEffectiveAppPermissions: () => ({
    isPending: false,
    isError: false,
    data: { groups: [], orgResources: null },
  }),
}));

vi.mock("@/lib/policy-editor/resource-scope", () => ({
  ResourceScopeFields: () => null,
}));

const CONNECTION = {
  id: "conn-1",
  provider: "aws",
  label: "prod",
} as Connection;

const customGrant: AgentGrantConnection = {
  connectionId: "conn-1",
  provider: "aws",
  label: "prod",
  scope: "workspace",
  access: "custom",
  allow: ["s3_read"],
  ask: [],
  otherReads: "never",
  otherWrites: "never",
  resources: null,
};

const renderDialog = (grant: AgentGrantConnection | undefined) =>
  render(
    <TooltipProvider>
      <ManagePermissionsDialog
        agentId="agent-1"
        connection={CONNECTION}
        grant={grant}
        readOnly={false}
        onClose={() => {}}
      />
    </TooltipProvider>,
  );

const toolOption = (tool: string, label: string) => {
  const row = screen.getByText(tool).closest("div.flex.items-start");
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${tool}`);
  return within(row).getByRole("button", { name: label });
};

describe("ManagePermissionsDialog: a catalog that blocks unlisted requests", () => {
  beforeEach(() => mutate.mockClear());

  // A custom AWS grant with every tool allowed and requests outside the list
  // needing approval. The rows must show that, not full access (the previous
  // dialog read every all-Allowed AWS grid as full access).
  it("shows an all-allowed custom grant as it is, not as full access", () => {
    renderDialog({
      ...customGrant,
      allow: ["s3_put", "s3_read"],
      otherReads: "ask",
      otherWrites: "ask",
    });
    for (const row of ["Other reads", "Other writes"]) {
      expect(
        within(screen.getByRole("group", { name: row })).getByRole("button", {
          name: "Needs approval",
        }),
      ).toHaveProperty("ariaPressed", "true");
    }
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("returns to full access: every tool and Not listed above on Allow", async () => {
    renderDialog(customGrant);
    // Customized: Always allow isn't offered on the catch-alls.
    expect(
      within(screen.getByRole("group", { name: "Other reads" })).getByRole(
        "button",
        { name: "Always allow" },
      ),
    ).toHaveProperty("disabled", true);

    await userEvent.click(toolOption("Write S3", "Always allow"));
    await userEvent.click(
      within(screen.getByRole("group", { name: "Other reads" })).getByRole(
        "button",
        { name: "Always allow" },
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ input: { access: "full" } }),
      expect.anything(),
    );
  });

  it("customizing a full grant writes Never on both catch-alls, never Allow", async () => {
    renderDialog(undefined);
    await userEvent.click(toolOption("Write S3", "Needs approval"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          access: "custom",
          allow: ["s3_read"],
          ask: ["s3_put"],
          otherReads: "never",
          otherWrites: "never",
        },
      }),
      expect.anything(),
    );
  });
});
