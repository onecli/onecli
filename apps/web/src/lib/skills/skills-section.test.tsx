// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { SkillSummary } from "@/lib/api";

// Radix Select needs the pointer-capture surface jsdom lacks; without these
// stubs the portal never opens and every option query is a false miss.
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

/**
 * The Skills section, both doors (the memory-section pattern): load states,
 * the three scope labels, the org-row read-only law on the workspace page,
 * and the create payload per audience. Hooks mocked at the module seam.
 */

const state = vi.hoisted(() => ({
  skills: [] as unknown[],
  orgSkills: [] as unknown[],
  isPending: false,
  isError: false,
  detail: null as unknown,
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  orgCreate: vi.fn(),
}));

vi.mock("@/hooks/use-skills", () => ({
  useSkills: () => ({
    data:
      state.isPending || state.isError ? undefined : { skills: state.skills },
    isPending: state.isPending,
    isError: state.isError,
  }),
  useOrgSkills: () => ({
    data: { skills: state.orgSkills },
    isPending: false,
    isError: false,
  }),
  useSkill: () => ({
    data: state.detail,
    isPending: state.detail === null,
    isSuccess: state.detail !== null,
  }),
  useOrgSkill: () => ({ data: null, isPending: false, isSuccess: false }),
  useCreateSkill: () => ({ mutate: state.create, isPending: false }),
  useUpdateSkill: () => ({ mutate: state.update, isPending: false }),
  useDeleteSkill: () => ({ mutate: state.remove, isPending: false }),
  useCreateOrgSkill: () => ({ mutate: state.orgCreate, isPending: false }),
  useUpdateOrgSkill: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteOrgSkill: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/use-agents", () => ({
  useAgents: () => ({
    data: [
      { id: "ag-1", name: "andy", kind: "hosted" },
      { id: "ag-2", name: "laptop", kind: "byo" },
    ],
    isPending: false,
  }),
}));

const { SkillsSection } = await import("./skills-section");

const skill = (overrides: Partial<SkillSummary> = {}): SkillSummary => ({
  id: "sk-1",
  scope: "workspace",
  agentId: null,
  workspaceId: "p1",
  organizationId: null,
  name: "release-checklist",
  description: "How we ship",
  enabled: true,
  createdByEmail: "admin@example.com",
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
  fileCount: 1,
  ...overrides,
});

/** The agent door, standing in ag-1's section, unless told otherwise. */
const renderSection = (tier: "agent" | "organization" = "agent") =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      {tier === "agent" ? (
        <SkillsSection tier="agent" agentId="ag-1" />
      ) : (
        <SkillsSection tier="organization" />
      )}
    </QueryClientProvider>,
  );

beforeEach(() => {
  state.skills = [];
  state.orgSkills = [];
  state.isPending = false;
  state.isError = false;
  state.detail = null;
  for (const fn of [state.create, state.update, state.remove, state.orgCreate])
    fn.mockReset();
});
afterEach(cleanup);

describe("load states", () => {
  it("error renders NO mutating controls — the apps-tab law", () => {
    state.isError = true;
    renderSection();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Skills failed to load",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("empty offers creation", () => {
    renderSection();
    expect(screen.getByText("No skills yet")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /New skill/ }),
    ).toBeInTheDocument();
  });
});

describe("rows and scope labels", () => {
  it("labels the tiers this agent carries — its own rows say so", () => {
    state.skills = [
      skill(),
      skill({
        id: "sk-2",
        name: "agent-only",
        scope: "agent",
        agentId: "ag-1",
      }),
      skill({
        id: "sk-3",
        name: "org-standards",
        scope: "organization",
        organizationId: "org-1",
      }),
    ];
    renderSection();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("This agent")).toBeInTheDocument();
    expect(screen.getByText("Organization")).toBeInTheDocument();
  });

  it("hides ANOTHER agent's rows — they are none of this agent's business", () => {
    state.skills = [
      skill(),
      skill({
        id: "sk-9",
        name: "someone-elses",
        scope: "agent",
        agentId: "ag-2",
      }),
    ];
    renderSection();
    expect(screen.getByText("release-checklist")).toBeInTheDocument();
    expect(screen.queryByText("someone-elses")).toBeNull();
  });

  it("an org row on the AGENT page is read-only with the org-page pointer", () => {
    state.skills = [
      skill({
        id: "sk-3",
        name: "org-standards",
        scope: "organization",
        organizationId: "org-1",
      }),
    ];
    renderSection();
    expect(
      screen.queryByRole("button", { name: "Edit org-standards" }),
    ).not.toBeInTheDocument();
    const link = screen.getByRole("link", {
      name: /Manage org-standards at the organization level/,
    });
    expect(link).toHaveAttribute("href", "/org/org-1/skills");
    // Read-only means read-only: no pause control either.
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("the switch IS the status, and toggling patches `enabled`", async () => {
    state.skills = [skill()];
    renderSection();
    // No separate badge — every state the row can be in, the switch shows.
    expect(screen.queryByText("Paused")).toBeNull();
    const toggle = screen.getByRole("switch", {
      name: "Pause release-checklist",
    });
    expect(toggle).toBeChecked();

    await userEvent.click(toggle);
    expect(state.update).toHaveBeenCalledWith(
      { skillId: "sk-1", patch: { enabled: false } },
      expect.anything(),
    );
  });

  it("a paused row offers Resume", () => {
    state.skills = [skill({ enabled: false })];
    renderSection();
    expect(
      screen.getByRole("switch", { name: "Resume release-checklist" }),
    ).not.toBeChecked();
  });
});

describe("the create dialog", () => {
  it("agent door: this agent first, then the workspace, then other HOSTED agents", async () => {
    renderSection();
    await userEvent.click(screen.getByRole("button", { name: /New skill/ }));
    await userEvent.click(screen.getByRole("combobox"));
    expect(
      screen.getByRole("option", { name: "Only this agent" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Everyone in this workspace" }),
    ).toBeInTheDocument();
    // The agent you are standing in is "this agent", never a second entry.
    expect(screen.queryByRole("option", { name: "Only andy" })).toBeNull();
    // BYO agents have no sandbox — never offered.
    expect(screen.queryByRole("option", { name: /laptop/ })).toBeNull();
  });

  it("defaults to THIS agent, and widens to the workspace when asked", async () => {
    renderSection();
    await userEvent.click(screen.getByRole("button", { name: /New skill/ }));
    await userEvent.type(screen.getByLabelText("Name"), "deploy-notes");
    await userEvent.type(screen.getByLabelText("Description"), "How to ship");
    await userEvent.type(
      screen.getByLabelText(/Instructions/),
      "Run the checks.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(state.create).toHaveBeenCalledWith(
      {
        name: "deploy-notes",
        description: "How to ship",
        content: "Run the checks.",
        agentId: "ag-1",
      },
      expect.anything(),
    );

    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(
      screen.getByRole("option", { name: "Everyone in this workspace" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(state.create).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ agentId: expect.anything() }),
      expect.anything(),
    );
  });

  it("org door: no audience picker; submit goes through the org hook", async () => {
    renderSection("organization");
    await userEvent.click(screen.getByRole("button", { name: /New skill/ }));
    expect(screen.queryByRole("combobox")).toBeNull();
    await userEvent.type(screen.getByLabelText("Name"), "org-standards");
    await userEvent.type(screen.getByLabelText("Description"), "House rules");
    await userEvent.type(screen.getByLabelText(/Instructions/), "Follow them.");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(state.orgCreate).toHaveBeenCalledWith(
      {
        name: "org-standards",
        description: "House rules",
        content: "Follow them.",
      },
      expect.anything(),
    );
    expect(state.create).not.toHaveBeenCalled();
  });

  it("edit disables the name (immutable) and seeds the body once", async () => {
    state.skills = [skill()];
    state.detail = {
      ...skill(),
      content: "Existing body",
      files: [],
    };
    renderSection();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit release-checklist" }),
    );
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    expect(name).toBeDisabled();
    expect(name.value).toBe("release-checklist");
    expect(screen.getByLabelText(/Instructions/)).toHaveValue("Existing body");
  });

  it("deleting asks first, and only then fires the mutation", async () => {
    state.skills = [skill()];
    state.detail = { ...skill(), content: "Existing body", files: [] };
    renderSection();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit release-checklist" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    // The click opens the confirm; nothing is deleted yet.
    expect(state.remove).not.toHaveBeenCalled();
    expect(
      screen.getByRole("alertdialog", { name: /Delete .release-checklist/ }),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Delete", hidden: false }),
    );
    expect(state.remove).toHaveBeenCalledWith("sk-1", expect.anything());
  });

  it("a file row with a path but no content blocks Save instead of vanishing", async () => {
    state.skills = [skill()];
    state.detail = { ...skill(), content: "Existing body", files: [] };
    renderSection();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit release-checklist" }),
    );
    await userEvent.click(screen.getByRole("button", { name: /Add file/ }));
    await userEvent.type(screen.getByLabelText("File 1 path"), "ref.md");

    expect(screen.getByText("Add content, or remove this file")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(state.update).not.toHaveBeenCalled();
  });
});
