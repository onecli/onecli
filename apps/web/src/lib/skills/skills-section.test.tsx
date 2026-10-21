// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
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

// No per-keystroke setTimeout: these tests type a lot and need no pacing.
const user = userEvent.setup({ delay: null });

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
 * the two scope labels, the org-row read-only law on the agent page, and
 * the create payload per door. Hooks mocked at the module seam.
 */

const state = vi.hoisted(() => ({
  skills: [] as unknown[],
  orgSkills: [] as unknown[],
  isPending: false,
  isError: false,
  detail: null as unknown,
  create: vi.fn(),
  update: vi.fn(),
  setEnabled: vi.fn(),
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
  useSetSkillEnabled: () => ({ mutate: state.setEnabled, isPending: false }),
  useDeleteSkill: () => ({ mutate: state.remove, isPending: false }),
  useCreateOrgSkill: () => ({ mutate: state.orgCreate, isPending: false }),
  useUpdateOrgSkill: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteOrgSkill: () => ({ mutate: vi.fn(), isPending: false }),
}));

// The dialog reads no agent list on either door (the audience picker is
// gone), so an org URL, which has no workspace, never asks for one. Spied,
// not stubbed, so a test can pin that it is never called.
const useAgents = vi.hoisted(() => vi.fn<(enabled?: boolean) => unknown>());
vi.mock("@/hooks/use-agents", () => ({ useAgents }));

// The GitHub library. `library` null = no repo
// connected (the listing 404s, so the Add-from-library button stays hidden).
const lib = vi.hoisted(() => ({
  connected: false,
  /** The connected library can no longer read its repo. */
  accessLost: false,
  /** The library's last error (null = healthy). */
  lastError: null as string | null,
  /** The org library read is still loading. */
  libraryPending: false,
  /** The agent's library-skills read: loading or failed. */
  agentSkillsPending: false,
  agentSkillsFailed: false,
  /** Whether the live listing was ever read (it waits for the picker). */
  availableRead: vi.fn(),
  /** The live listing failed for a reason other than "no library". */
  listingFailed: false,
  agentSkills: [] as unknown[],
  available: [] as unknown[],
  attach: vi.fn(),
  detach: vi.fn(),
  setEnabled: vi.fn(),
  resync: vi.fn(),
  disconnect: vi.fn(),
  usage: { skillNames: [] as string[], agentCount: 0 },
}));

// A failed listing, with the status the client carries: 404 is "no library
// connected", anything else is a read that failed.
const failedListing = vi.hoisted(() => (status: number, message: string) => ({
  data: undefined,
  isPending: false,
  isError: true,
  error: Object.assign(new Error(message), { status }),
  refetch: vi.fn(),
}));
const noLibrary = vi.hoisted(() =>
  failedListing(404, "No skill library is connected"),
);

vi.mock("@/hooks/use-skill-library", () => ({
  isNoLibrary: (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 404,
  useLibraryGitHubAccounts: () => ({ data: [], isPending: false }),
  useLibraryAccessRepos: () => ({ data: undefined, isPending: false }),
  useOrgSkillLibrary: () =>
    lib.libraryPending
      ? { data: undefined, isPending: true, isError: false }
      : {
          data: {
            source: lib.connected
              ? {
                  id: "src",
                  repo: "acme/claude-skills",
                  branch: "main",
                  headSha: "a1b2c3d4e5",
                  lastSyncedAt: "2026-10-18T00:00:00.000Z",
                  lastError: lib.lastError,
                  accessLost: lib.accessLost,
                  appConnectionId: "conn",
                  account: "acme",
                  accountType: "Organization",
                  installationId: "42",
                }
              : null,
            usage: lib.connected ? lib.usage : null,
            skillsOnlyInstall: true,
          },
          isPending: false,
          isError: false,
        },
  useAgentLibrarySkills: () =>
    lib.agentSkillsPending
      ? { data: undefined, isPending: true, isSuccess: false, isError: false }
      : lib.agentSkillsFailed
        ? {
            data: undefined,
            isPending: false,
            isSuccess: false,
            isError: true,
            error: new Error("boom"),
            refetch: vi.fn(),
          }
        : {
            data: { skills: lib.agentSkills },
            isPending: false,
            isSuccess: true,
            isError: false,
          },
  useAgentAvailableLibrarySkills: (_agentId: string, enabled = true) => {
    if (enabled) lib.availableRead();
    return lib.listingFailed
      ? failedListing(502, "GitHub did not respond in time")
      : lib.connected
        ? {
            data: {
              repo: "acme/claude-skills",
              commitSha: "a1b2c3d4e5",
              truncated: false,
              skills: lib.available,
            },
            isPending: false,
            isError: false,
          }
        : noLibrary;
  },
  useOrgRepoSkills: () =>
    lib.connected
      ? {
          data: {
            repo: "acme/claude-skills",
            commitSha: "a1b2c3d4e5",
            truncated: false,
            skills: lib.available,
          },
          isPending: false,
          isError: false,
        }
      : noLibrary,
  useAttachLibrarySkills: () => ({ mutate: lib.attach, isPending: false }),
  useDetachLibrarySkill: () => ({
    mutate: lib.detach,
    isPending: false,
    variables: undefined,
  }),
  useSetLibrarySkillEnabled: () => ({
    mutate: lib.setEnabled,
    isPending: false,
  }),
  useResyncLibrarySkill: () => ({
    mutate: lib.resync,
    isPending: false,
    variables: undefined,
  }),
  useDisconnectSkillLibrary: () => ({
    mutate: lib.disconnect,
    isPending: false,
  }),
  useConnectSkillLibrary: () => ({ mutate: vi.fn(), isPending: false }),
}));

const librarySkill = (overrides: Record<string, unknown> = {}) => ({
  id: "lib-1",
  name: "snowflake",
  description: "Use when querying Snowflake",
  plugin: "data-tools",
  path: "plugins/data-tools/skills/snowflake",
  commitSha: "a1b2c3d4e5",
  enabled: true,
  agentCount: 1,
  fileCount: 2,
  skipped: [],
  lastError: null,
  updatedAt: "2026-10-18T00:00:00.000Z",
  status: "current",
  repoSha: "a1b2c3d4e5",
  checkedAt: "2026-10-18T00:00:00.000Z",
  ...overrides,
});

const { SkillsSection } = await import("./skills-section");

const skill = (overrides: Partial<SkillSummary> = {}): SkillSummary => ({
  id: "sk-1",
  scope: "agent",
  agentId: "ag-1",
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
  lib.connected = false;
  lib.accessLost = false;
  lib.lastError = null;
  lib.libraryPending = false;
  lib.agentSkillsPending = false;
  lib.agentSkillsFailed = false;
  lib.availableRead.mockClear();
  lib.listingFailed = false;
  lib.agentSkills = [];
  lib.available = [];
  lib.usage = { skillNames: [], agentCount: 0 };
  lib.attach.mockReset();
  lib.detach.mockClear();
  lib.setEnabled.mockReset();
  lib.resync.mockReset();
  lib.disconnect.mockReset();
  for (const fn of [
    state.create,
    state.update,
    state.setEnabled,
    state.remove,
    state.orgCreate,
  ])
    fn.mockReset();
  useAgents.mockClear();
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
  it("labels the two tiers this agent carries — its own rows say so", () => {
    state.skills = [
      skill(),
      skill({
        id: "sk-3",
        name: "org-standards",
        scope: "organization",
        agentId: null,
        organizationId: "org-1",
      }),
    ];
    renderSection();
    expect(screen.getByText("This agent")).toBeInTheDocument();
    expect(screen.getByText("Organization")).toBeInTheDocument();
    expect(screen.queryByText("Workspace")).toBeNull();
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
        agentId: null,
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

    await user.click(toggle);
    expect(state.setEnabled).toHaveBeenCalledWith({
      skillId: "sk-1",
      enabled: false,
    });
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
  it("agent door: no audience picker — the skill is always THIS agent's", async () => {
    renderSection();
    await user.click(screen.getByRole("button", { name: /New skill/ }));
    expect(useAgents).not.toHaveBeenCalled();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText("Who gets it")).toBeNull();
    await user.type(screen.getByLabelText(/^Name/), "deploy-notes");
    await user.type(screen.getByLabelText(/^Description/), "How to ship");
    await user.type(screen.getByLabelText(/Instructions/), "Run the checks.");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(state.create).toHaveBeenCalledWith(
      {
        name: "deploy-notes",
        description: "How to ship",
        content: "Run the checks.",
        agentId: "ag-1",
      },
      expect.anything(),
    );
    expect(state.orgCreate).not.toHaveBeenCalled();
  });

  it("org door: no audience picker; submit goes through the org hook", async () => {
    renderSection("organization");
    await user.click(screen.getByRole("button", { name: /New skill/ }));
    // An org URL has no workspace, so the agent list is never read there.
    expect(useAgents).not.toHaveBeenCalled();
    expect(screen.queryByRole("combobox")).toBeNull();
    await user.type(screen.getByLabelText(/^Name/), "org-standards");
    await user.type(screen.getByLabelText(/^Description/), "House rules");
    await user.type(screen.getByLabelText(/Instructions/), "Follow them.");
    await user.click(screen.getByRole("button", { name: "Create" }));
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
    await user.click(
      screen.getByRole("button", { name: "Edit release-checklist" }),
    );
    const name = screen.getByLabelText(/^Name/) as HTMLInputElement;
    expect(name).toBeDisabled();
    expect(name.value).toBe("release-checklist");
    // Immutable here, so it is not marked required: nothing to fill in.
    expect(name.labels?.[0]).toHaveTextContent(/^Name$/);
    expect(screen.getByLabelText(/Instructions/)).toHaveValue("Existing body");
  });

  it("flags the empty instructions field when the skill was pasted into a file", async () => {
    state.skills = [skill()];
    state.detail = { ...skill(), content: "Existing body", files: [] };
    renderSection();
    await user.click(
      screen.getByRole("button", { name: "Edit release-checklist" }),
    );
    await user.click(screen.getByRole("button", { name: /Add file/ }));
    await user.type(screen.getByLabelText("File 1 path"), "ref.md");
    await user.type(
      screen.getByLabelText("File 1 content"),
      "The whole skill, pasted here by mistake.",
    );
    await user.clear(screen.getByLabelText(/Instructions/));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(state.update).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Instructions/)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByLabelText(/Instructions/)).toHaveFocus();
    expect(screen.getByText("Fill in the required fields.")).toBeVisible();
  });

  it("deleting asks first, and only then fires the mutation", async () => {
    state.skills = [skill()];
    state.detail = { ...skill(), content: "Existing body", files: [] };
    renderSection();
    await user.click(
      screen.getByRole("button", { name: "Edit release-checklist" }),
    );
    await user.click(screen.getByRole("button", { name: "Delete" }));
    // The click opens the confirm; nothing is deleted yet.
    expect(state.remove).not.toHaveBeenCalled();
    expect(
      screen.getByRole("alertdialog", { name: /Delete .release-checklist/ }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Delete", hidden: false }),
    );
    expect(state.remove).toHaveBeenCalledWith("sk-1");
  });

  it("keeps extra files shut until the SKILL.md body is written", async () => {
    renderSection();
    await user.click(screen.getByRole("button", { name: /New skill/ }));

    // The observed failure starts here: the user reaches for "Add file"
    // before writing the body, and pastes the whole skill into it. The lock
    // says why in VISIBLE text: a disabled button takes no pointer events,
    // so a `title` tooltip on it would never show.
    const addFile = screen.getByRole("button", { name: /Add file/ });
    expect(addFile).toBeDisabled();
    expect(addFile).not.toHaveAttribute("title");
    expect(screen.getByText("Write the instructions first")).toBeVisible();
    expect(addFile).toHaveAccessibleDescription("Write the instructions first");

    await user.type(screen.getByLabelText(/Instructions/), "Do the thing.");
    expect(screen.getByRole("button", { name: /Add file/ })).toBeEnabled();
    expect(screen.queryByText("Write the instructions first")).toBeNull();
    expect(
      screen.getByRole("button", { name: /Add file/ }),
    ).not.toHaveAccessibleDescription();
  });

  it("clicking Create on an incomplete form marks what is missing", async () => {
    renderSection();
    await user.click(screen.getByRole("button", { name: /New skill/ }));
    // An untouched form is not an error state, and the button is never dead.
    expect(screen.getByLabelText(/Instructions/)).toHaveAttribute(
      "aria-invalid",
      "false",
    );
    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
    // The status region is mounted up front (so screen readers announce what
    // later lands in it) but says nothing yet.
    expect(screen.getByRole("status")).toHaveTextContent("");

    await user.type(screen.getByLabelText(/^Name/), "deploy-notes");
    await user.type(screen.getByLabelText(/^Description/), "How to ship");
    await user.click(screen.getByRole("button", { name: "Create" }));

    // The click answers instead of saving: field marked, caret moved there.
    expect(state.create).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Instructions/)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByLabelText(/Instructions/)).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Fill in the required fields.",
    );
    expect(
      screen.getByRole("button", { name: "Create" }),
    ).toHaveAccessibleDescription("Fill in the required fields.");

    await user.type(screen.getByLabelText(/Instructions/), "Run it.");
    expect(screen.getByLabelText(/Instructions/)).toHaveAttribute(
      "aria-invalid",
      "false",
    );
    expect(screen.getByRole("status")).toHaveTextContent("");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(state.create).toHaveBeenCalled();
  });

  it("the message and the caret always point at the same problem", async () => {
    renderSection();
    await user.click(screen.getByRole("button", { name: /New skill/ }));
    await user.type(screen.getByLabelText(/^Description/), "How to ship");
    await user.type(screen.getByLabelText(/Instructions/), "Run it.");
    await user.click(screen.getByRole("button", { name: /Add file/ }));
    await user.type(screen.getByLabelText("File 1 path"), "Notes.md");
    await user.type(screen.getByLabelText("File 1 content"), "More.");

    // Two problems: an empty Name above a bad file. Form order decides, and
    // the words follow the caret rather than naming the file below it.
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByLabelText(/^Name/)).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Fill in the required fields.",
    );

    await user.type(screen.getByLabelText(/^Name/), "deploy-notes");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByLabelText("File 1 path")).toHaveFocus();
    expect(screen.getByLabelText("File 1 path")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByLabelText("File 1 path")).toHaveAccessibleDescription(
      /at most two lowercase segments/,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Fix the highlighted file.",
    );
    expect(state.create).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText("File 1 path"));
    await user.type(screen.getByLabelText("File 1 path"), "notes.md");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(state.create).toHaveBeenCalled();
  });

  it("a skill over the size cap says so and goes back to the body", async () => {
    renderSection();
    await user.click(screen.getByRole("button", { name: /New skill/ }));
    await user.type(screen.getByLabelText(/^Name/), "deploy-notes");
    await user.type(screen.getByLabelText(/^Description/), "How to ship");
    await user.click(screen.getByLabelText(/Instructions/));
    await user.paste("x".repeat(32_001));
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(state.create).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Instructions/)).toHaveFocus();
    expect(screen.getByLabelText(/Instructions/)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Too long to save. Shorten the instructions or files.",
    );
  });

  it("a file row with a path but no content blocks Save instead of vanishing", async () => {
    state.skills = [skill()];
    state.detail = { ...skill(), content: "Existing body", files: [] };
    renderSection();
    await user.click(
      screen.getByRole("button", { name: "Edit release-checklist" }),
    );
    await user.click(screen.getByRole("button", { name: /Add file/ }));
    await user.type(screen.getByLabelText("File 1 path"), "ref.md");

    expect(screen.getByText("Add content, or remove this file")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(state.update).not.toHaveBeenCalled();
    expect(screen.getByText("Fix the highlighted file.")).toBeVisible();
    // The caret lands on the input the problem is about: the empty content.
    expect(screen.getByLabelText("File 1 content")).toHaveFocus();
    expect(screen.getByLabelText("File 1 content")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });
});

describe("the GitHub library", () => {
  it("no repo connected: no Add-from-library button and no library section", () => {
    renderSection();
    expect(
      screen.queryByRole("button", { name: /Add from library/ }),
    ).toBeNull();
    expect(screen.queryByText("From library")).toBeNull();
  });

  it("agent door: library skills are read-only, with an on/off switch and remove, like regular skills", async () => {
    lib.connected = true;
    lib.agentSkills = [
      librarySkill(),
      librarySkill({ id: "lib-2", name: "onyx", enabled: false }),
    ];
    renderSection();
    expect(screen.getByText("From library")).toBeInTheDocument();
    expect(screen.getAllByText("GitHub library")).toHaveLength(2);
    // Read-only content: no edit on library rows.
    expect(screen.queryByRole("button", { name: "Edit snowflake" })).toBeNull();
    // The switch reflects each agent's own state and flips it.
    expect(
      screen.getByRole("switch", { name: "Pause snowflake" }),
    ).toBeChecked();
    const onyx = screen.getByRole("switch", { name: "Resume onyx" });
    expect(onyx).not.toBeChecked();
    await user.click(onyx);
    expect(lib.setEnabled).toHaveBeenCalledWith({
      name: "onyx",
      enabled: true,
    });
    // Every library row can be removed from this agent, from its ⋯ menu.
    expect(
      screen.getByRole("button", { name: "Options for onyx" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Options for snowflake" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Remove from this agent/ }),
    );
    // It asks first: nothing is removed until the confirm.
    const confirm = await screen.findByRole("alertdialog", {
      name: /Remove .snowflake. from this agent/,
    });
    expect(lib.detach).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole("button", { name: "Remove" }));
    expect(lib.detach).toHaveBeenCalledWith("snowflake", expect.anything());
    expect(
      screen.getByRole("link", { name: "View snowflake on GitHub" }),
    ).toHaveAttribute(
      "href",
      "https://github.com/acme/claude-skills/tree/a1b2c3d4e5/plugins/data-tools/skills/snowflake",
    );
  });

  it("an agent holding only library skills never reads 'No skills yet'", () => {
    lib.connected = true;
    lib.agentSkills = [librarySkill()];
    renderSection();
    expect(screen.getByText("From library")).toBeInTheDocument();
    expect(screen.queryByText("No skills yet")).toBeNull();
    expect(
      screen.getByRole("button", { name: /New skill/ }),
    ).toBeInTheDocument();
  });

  it("the picker groups the repo by plugin and adds a skill to THIS agent", async () => {
    lib.connected = true;
    lib.available = [
      {
        path: "plugins/data-tools/skills/snowflake",
        folder: "snowflake",
        plugin: "data-tools",
        fileCount: 2,
        name: "snowflake",
        description: "Use when querying Snowflake",
        problem: null,
        conflicts: [],
        added: true,
      },
      {
        path: "plugins/data-tools/skills/dbt",
        folder: "dbt",
        plugin: "data-tools",
        fileCount: 1,
        name: "dbt",
        description: "How dbt works",
        problem: null,
        conflicts: [],
        added: false,
      },
      {
        path: "plugins/eng/skills/broken",
        folder: "broken",
        plugin: "eng",
        fileCount: 1,
        name: "not-broken",
        description: "x",
        problem: 'Name "not-broken" doesn\'t match its folder "broken"',
        conflicts: [],
        added: false,
      },
    ];
    renderSection();
    await user.click(screen.getByRole("button", { name: /Add from library/ }));
    expect(screen.getByText("data-tools")).toBeInTheDocument();
    expect(screen.getByText("eng")).toBeInTheDocument();
    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(screen.getByText("Can't be used")).toBeInTheDocument();
    expect(screen.getByText(/doesn't match its folder/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add dbt" }));
    expect(lib.attach).toHaveBeenCalledWith(
      expect.objectContaining({ names: ["dbt"] }),
      expect.anything(),
    );
  });

  it("two folders claiming one name are both blocked, each linking the other on GitHub; Show issues filters to them", async () => {
    lib.connected = true;
    lib.available = [
      {
        path: "plugins/a/skills/review",
        folder: "review",
        plugin: "a",
        fileCount: 1,
        name: "review",
        description: "A's review",
        problem: "Name used twice in the repo",
        conflicts: ["plugins/z/skills/review"],
        added: false,
      },
      {
        path: "plugins/z/skills/review",
        folder: "review",
        plugin: "z",
        fileCount: 1,
        name: "review",
        description: "Z's review",
        problem: "Name used twice in the repo",
        conflicts: ["plugins/a/skills/review"],
        added: false,
      },
      {
        path: "plugins/a/skills/fine",
        folder: "fine",
        plugin: "a",
        fileCount: 1,
        name: "fine",
        description: "OK",
        problem: null,
        conflicts: [],
        added: false,
      },
    ];
    renderSection();
    await user.click(screen.getByRole("button", { name: /Add from library/ }));
    expect(screen.getAllByText("Name used twice")).toHaveLength(2);
    expect(
      screen.getByRole("link", { name: /plugins\/z\/skills\/review/ }),
    ).toHaveAttribute(
      "href",
      "https://github.com/acme/claude-skills/tree/a1b2c3d4e5/plugins/z/skills/review",
    );
    // Only the usable skill can be added.
    expect(screen.getAllByRole("button", { name: /^Add / })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Add fine" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /Show issues \(2\)/ }));
    expect(screen.queryByText("fine")).toBeNull();
    expect(screen.getAllByText("review")).toHaveLength(2);
  });

  it("a listing that failed for another reason keeps the button and shows the reason with Retry", async () => {
    lib.connected = true;
    lib.listingFailed = true;
    renderSection();
    await user.click(screen.getByRole("button", { name: /Add from library/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("GitHub did not respond in time");
    expect(
      within(alert).getByRole("button", { name: "Retry" }),
    ).toBeInTheDocument();
  });

  it("org door: the repo card, and a read-only preview (nothing to add or switch)", async () => {
    lib.connected = true;
    lib.available = [
      {
        path: "plugins/data-tools/skills/snowflake",
        folder: "snowflake",
        plugin: "data-tools",
        fileCount: 2,
        name: "snowflake",
        description: "Use when querying Snowflake",
        problem: null,
        conflicts: [],
        added: false,
      },
      {
        path: "plugins/eng/skills/broken",
        folder: "broken",
        plugin: "eng",
        fileCount: 1,
        name: "broken",
        description: "",
        problem: "SKILL.md has no description",
        conflicts: [],
        added: false,
      },
    ];
    renderSection("organization");
    expect(screen.getByText("acme/claude-skills")).toBeInTheDocument();
    // Usable skills only (the broken one isn't counted).
    expect(screen.getByText("1 skill found")).toBeInTheDocument();
    expect(screen.getByText("1 can't be used")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Add from library/ }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: /Preview library/ }));
    expect(await screen.findByText("Library preview")).toBeInTheDocument();
    expect(screen.getByText("snowflake")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "View snowflake on GitHub" }),
    ).toHaveAttribute(
      "href",
      "https://github.com/acme/claude-skills/tree/a1b2c3d4e5/plugins/data-tools/skills/snowflake",
    );
    expect(screen.getByText("Can't be used")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Add / })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add all/ })).toBeNull();
    expect(lib.attach).not.toHaveBeenCalled();
  });

  it("disconnect asks first and names what leaves the agents", async () => {
    lib.connected = true;
    lib.usage = { skillNames: ["snowflake", "dbt"], agentCount: 4 };
    renderSection("organization");
    await user.click(screen.getByRole("button", { name: "Library options" }));
    await user.click(
      await screen.findByRole("menuitem", { name: /Disconnect/ }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(lib.disconnect).not.toHaveBeenCalled();
    expect(within(dialog).getByText("2 library skills")).toBeInTheDocument();
    expect(within(dialog).getByText("4 agents")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/doesn't bring them back/),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Disconnect" }),
    );
    expect(lib.disconnect).toHaveBeenCalled();
  });

  it("shows whether each library skill matches the repo, and re-syncs one", async () => {
    lib.connected = true;
    lib.agentSkills = [
      librarySkill(),
      librarySkill({
        id: "lib-2",
        name: "dbt",
        commitSha: "1111111aaa",
        repoSha: "2222222bbb",
        status: "behind",
      }),
      librarySkill({
        id: "lib-3",
        name: "onyx",
        status: "error",
        lastError: "Removed from the repo",
      }),
    ];
    renderSection();
    expect(screen.getByText(/Up to date @ a1b2c3d/)).toBeInTheDocument();
    expect(
      screen.getByText(/Update available: 1111111 → 2222222/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Kept last version: Removed/)).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /^Re-sync dbt from GitHub/ }),
    );
    expect(lib.resync).toHaveBeenCalledWith("dbt", expect.anything());
  });

  it("Re-sync says it updates every agent using a shared skill", () => {
    lib.connected = true;
    lib.agentSkills = [librarySkill({ agentCount: 3 })];
    renderSection();
    expect(
      screen.getByRole("button", {
        name: "Re-sync snowflake from GitHub. Updates it for all 3 agents using it",
      }),
    ).toBeInTheDocument();
  });

  it("source chips are colored per type", () => {
    state.skills = [
      skill({ id: "a", name: "mine", scope: "agent", agentId: "ag-1" }),
      skill({
        id: "o",
        name: "house",
        scope: "organization",
        organizationId: "org-1",
      }),
    ];
    renderSection();
    expect(screen.getByText("This agent").className).toMatch(/emerald/);
    expect(screen.getByText("Organization").className).toMatch(/orange/);
  });
});

describe("the GitHub library, review fixes", () => {
  const repoSkill = (overrides: Record<string, unknown> = {}) => ({
    path: "plugins/data-tools/skills/snowflake",
    folder: "snowflake",
    plugin: "data-tools",
    fileCount: 2,
    name: "snowflake",
    description: "Use when querying Snowflake",
    problem: null,
    conflicts: [],
    added: false,
    ...overrides,
  });

  it("the Add-from-library button follows the org library, and the listing waits for the picker", async () => {
    lib.connected = true;
    lib.available = [repoSkill()];
    renderSection();
    const button = screen.getByRole("button", { name: /Add from library/ });
    // A plain button: no icon-only error signal, never disabled while loading.
    expect(button).toBeEnabled();
    expect(lib.availableRead).not.toHaveBeenCalled();
    await user.click(button);
    expect(lib.availableRead).toHaveBeenCalled();
    expect(screen.getByText("snowflake")).toBeInTheDocument();
  });

  it("'No skills yet' waits for the library read: no flash while it loads", () => {
    lib.agentSkillsPending = true;
    renderSection();
    expect(screen.queryByText("No skills yet")).toBeNull();
  });

  it("'No skills yet' never sits above a failed library read", () => {
    lib.agentSkillsFailed = true;
    renderSection();
    expect(screen.queryByText("No skills yet")).toBeNull();
    expect(
      screen.getByText("Couldn't load this agent's library skills."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /New skill/ }),
    ).toBeInTheDocument();
  });

  it("picker search ignores case in names and plugins, and closing resets it", async () => {
    lib.connected = true;
    lib.available = [
      repoSkill({ name: "Snowflake", plugin: "Data-Tools" }),
      repoSkill({
        path: "plugins/eng/skills/review",
        folder: "review",
        plugin: "eng",
        name: "review",
        description: "Code review",
      }),
    ];
    renderSection();
    await user.click(screen.getByRole("button", { name: /Add from library/ }));
    const search = screen.getByRole("textbox", {
      name: "Search library skills",
    });
    await user.type(search, "SNOW");
    expect(screen.getByText("Snowflake")).toBeInTheDocument();
    expect(screen.queryByText("review")).toBeNull();
    await user.clear(search);
    await user.type(search, "data-TOOLS");
    expect(screen.getByText("Snowflake")).toBeInTheDocument();
    expect(screen.queryByText("review")).toBeNull();

    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /Add from library/ }));
    expect(
      screen.getByRole("textbox", { name: "Search library skills" }),
    ).toHaveValue("");
    expect(screen.getByText("review")).toBeInTheDocument();
  });

  it("an add in flight keeps the picker open", async () => {
    lib.connected = true;
    lib.available = [repoSkill()];
    // The run never settles: the picker stays busy.
    lib.attach.mockImplementation(() => {});
    renderSection();
    await user.click(screen.getByRole("button", { name: /Add from library/ }));
    await user.click(screen.getByRole("button", { name: "Add snowflake" }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("GitHub links encode each folder name, keeping the slashes", async () => {
    lib.connected = true;
    lib.available = [
      repoSkill({ path: "plugins/data tools/skills/snow#flake" }),
    ];
    lib.agentSkills = [
      librarySkill({ path: "plugins/data tools/skills/snow#flake" }),
    ];
    renderSection();
    const expected =
      "https://github.com/acme/claude-skills/tree/a1b2c3d4e5/plugins/data%20tools/skills/snow%23flake";
    expect(
      screen.getByRole("link", { name: "View snowflake on GitHub" }),
    ).toHaveAttribute("href", expected);
    await user.click(screen.getByRole("button", { name: /Add from library/ }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByRole("link", { name: "View snowflake on GitHub" }),
    ).toHaveAttribute("href", expected);
  });

  it("org door: a loading library holds its place with a skeleton", () => {
    lib.libraryPending = true;
    renderSection("organization");
    expect(
      screen.getByText("Loading the GitHub skill library"),
    ).toBeInTheDocument();
  });

  it("org door: lost access is read from the source, offers Reconnect, and the error has its own line", async () => {
    lib.connected = true;
    lib.accessLost = true;
    lib.lastError =
      "The OneCLI GitHub App can no longer read acme/claude-skills";
    renderSection("organization");
    expect(screen.getByText("Access lost")).toBeInTheDocument();
    const error = screen.getByText(lib.lastError);
    expect(error.tagName).toBe("P");
    expect(error.className).toMatch(/break-words/);
    expect(
      screen.queryByRole("button", { name: /Preview library/ }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(
      await screen.findByRole("heading", {
        name: "Reconnect the skill library",
      }),
    ).toBeInTheDocument();
  });

  it("org door: an error that isn't lost access says Needs attention, not Access lost", () => {
    lib.connected = true;
    lib.lastError = "GitHub access lost, maybe";
    renderSection("organization");
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.queryByText("Access lost")).toBeNull();
    expect(
      screen.getByRole("button", { name: /Preview library/ }),
    ).toBeInTheDocument();
  });

  it("an update available shows an icon too, not color alone", () => {
    lib.connected = true;
    lib.agentSkills = [
      librarySkill({
        commitSha: "1111111aaa",
        repoSha: "2222222bbb",
        status: "behind",
      }),
    ];
    renderSection();
    const label = screen.getByText(/Update available/);
    expect(label.querySelector("svg")).not.toBeNull();
  });
});
