// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import type { SkillSource } from "@/lib/api";
import { ConnectLibraryForm } from "./connect-library-form";

// The real hooks → typed client chain runs; only HTTP is stubbed.
const mocks = vi.hoisted(() => ({
  apiGet: vi.fn<(path: string) => Promise<unknown>>(),
  apiPost: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
  apiPut: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
}));
vi.mock("@/lib/api/client", () => ({
  ApiError: class extends Error {
    status: number;
    details: unknown;
    constructor(message: string, status: number, details?: unknown) {
      super(message);
      this.status = status;
      this.details = details;
    }
  },
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
  apiPut: mocks.apiPut,
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({ useParams: () => ({ orgId: "org-1" }) }));

const wrap = (ui: ReactNode) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {ui}
  </QueryClientProvider>
);

const answer = (accounts: unknown[]) =>
  mocks.apiGet.mockImplementation(async (path: string) => {
    if (path === "/v1/org/skill-library/github-accounts") return accounts;
    throw new Error(`unexpected GET ${path}`);
  });

/** The repo menu's answer, with the installation the access reaches. */
const reposOf = (
  repos: string[],
  installation = {
    installationId: "42",
    account: "acme",
    accountType: "Organization",
  },
  truncated = false,
) => ({ repos, truncated, installation });

const orgAccount = {
  appConnectionId: "conn-1",
  installationId: "77",
  account: "acme-org",
  accountType: "Organization",
};

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// Radix's Select drives its listbox through pointer-capture and scroll APIs
// jsdom does not implement; stubbing them is what makes the component's real
// interaction path testable at all.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

describe("ConnectLibraryForm", () => {
  it("with no org GitHub connection, offers an install for skills only", async () => {
    answer([]);
    render(
      wrap(
        <ConnectLibraryForm
          current={null}
          usage={null}
          skillsOnlyInstall
          onDone={() => {}}
        />,
      ),
    );
    expect(
      await screen.findByRole("button", { name: /Install GitHub for skills/ }),
    ).toBeTruthy();
    expect(screen.getByText(/won.t appear under Connections/)).toBeTruthy();
  });

  it("an install for skills only connects with its grant, never a connection id", async () => {
    answer([]);
    mocks.apiPost.mockResolvedValue(reposOf(["acme/skills"]));
    mocks.apiPut.mockResolvedValue({ repo: "acme/skills" });
    const popup = { location: { href: "" } };
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(popup as unknown as Window);
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(
      wrap(
        <ConnectLibraryForm
          current={null}
          usage={null}
          skillsOnlyInstall
          onDone={onDone}
        />,
      ),
    );

    await user.click(
      await screen.findByRole("button", { name: /Install GitHub for skills/ }),
    );
    await waitFor(() =>
      expect(popup.location.href).toContain(
        "/v1/apps/github-app/authorize?purpose=skills&_org=org-1",
      ),
    );

    // Another window's message is ignored; the popup's is taken.
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: window,
        data: { type: "skill-library-github-granted", grant: "forged" },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: popup as unknown as Window,
        data: { type: "skill-library-github-granted", grant: "signed.grant" },
      }),
    );

    await waitFor(() =>
      expect(mocks.apiPost).toHaveBeenCalledWith(
        "/v1/org/skill-library/access/repositories",
        { grant: "signed.grant" },
      ),
    );
    expect(mocks.apiPost).not.toHaveBeenCalledWith(expect.anything(), {
      grant: "forged",
    });

    // Pick the repo and connect: the PUT carries the grant, never an id.
    expect(
      await screen.findByRole("combobox", { name: "GitHub access" }),
    ).toHaveTextContent("New install · skills only");
    await user.click(
      await screen.findByRole("combobox", { name: "Repository" }),
    );
    await user.click(
      await screen.findByRole("option", { name: "acme/skills" }),
    );
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(mocks.apiPut).toHaveBeenCalledWith("/v1/org/skill-library", {
        grant: "signed.grant",
        repo: "acme/skills",
        branch: "main",
      }),
    );
    expect(onDone).toHaveBeenCalled();
    open.mockRestore();
  });

  const current: SkillSource = {
    id: "src-1",
    repo: "acme/skills",
    branch: "main",
    headSha: "c1",
    lastSyncedAt: null,
    lastError: null,
    accessLost: false,
    appConnectionId: null,
    account: "acme",
    accountType: "Organization",
    installationId: "42",
  };
  const usage = { skillNames: ["snowflake", "dbt"], agentCount: 3 };

  it("switching the branch while agents use skills asks first, then confirms with replace", async () => {
    answer([]);
    mocks.apiPost.mockResolvedValue(reposOf(["acme/skills"]));
    mocks.apiPut.mockResolvedValue({ ...current, branch: "release" });
    const onDone = vi.fn();
    const user = userEvent.setup();
    render(
      wrap(
        <ConnectLibraryForm
          current={current}
          usage={usage}
          skillsOnlyInstall
          onDone={onDone}
        />,
      ),
    );
    const branch = await screen.findByLabelText("Branch");
    await user.clear(branch);
    await user.type(branch, "release");
    await user.click(screen.getByRole("button", { name: "Switch branch…" }));

    // Nothing sent yet: the confirm names the cost.
    const dialog = await screen.findByRole("alertdialog");
    expect(mocks.apiPut).not.toHaveBeenCalled();
    expect(within(dialog).getByText("2 library skills")).toBeTruthy();
    expect(within(dialog).getByText("3 agents")).toBeTruthy();
    expect(within(dialog).getByText("snowflake")).toBeTruthy();

    await user.click(
      within(dialog).getByRole("button", {
        name: "Switch and remove 2 skills",
      }),
    );
    await waitFor(() =>
      expect(mocks.apiPut).toHaveBeenCalledWith("/v1/org/skill-library", {
        repo: "acme/skills",
        branch: "release",
        replace: true,
      }),
    );
    expect(onDone).toHaveBeenCalled();
  });

  it("a server refusal with the impact opens the same confirm (another admin added skills meanwhile)", async () => {
    answer([]);
    mocks.apiPost.mockResolvedValue(reposOf(["acme/skills"]));
    mocks.apiPut.mockRejectedValueOnce(
      new ApiError("Switching removes", 409, {
        skillNames: ["dbt"],
        agentCount: 1,
      }),
    );
    const user = userEvent.setup();
    render(
      wrap(
        <ConnectLibraryForm
          current={current}
          usage={{ skillNames: [], agentCount: 0 }}
          skillsOnlyInstall
          onDone={() => {}}
        />,
      ),
    );
    const branch = await screen.findByLabelText("Branch");
    await user.clear(branch);
    await user.type(branch, "release");
    await user.click(screen.getByRole("button", { name: "Switch branch…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("dbt")).toBeTruthy();
  });

  it("a failed account list says so with Retry, never 'install GitHub'", async () => {
    mocks.apiGet.mockRejectedValueOnce(new Error("boom"));
    const user = userEvent.setup();
    render(
      wrap(
        <ConnectLibraryForm
          current={null}
          usage={null}
          skillsOnlyInstall
          onDone={() => {}}
        />,
      ),
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Install GitHub/ })).toBeNull();
    answer([]);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("button", { name: /Install GitHub for skills/ }),
    ).toBeTruthy();
  });

  it("without the skills-only install, no org account says: connect GitHub to the organization first", async () => {
    answer([]);
    render(
      wrap(
        <ConnectLibraryForm
          current={null}
          usage={null}
          skillsOnlyInstall={false}
          onDone={() => {}}
        />,
      ),
    );
    expect(
      await screen.findByText(/Connect GitHub to the organization first/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Install GitHub/ })).toBeNull();
    expect(
      screen.getByRole("link", { name: "Go to Shared Connections" }),
    ).toHaveAttribute("href", "/org/org-1/settings/global-connections");
  });

  it("without the skills-only install, an org account is offered alone (no install link)", async () => {
    answer([orgAccount]);
    mocks.apiPost.mockResolvedValue(reposOf(["acme-org/skills"]));
    render(
      wrap(
        <ConnectLibraryForm
          current={null}
          usage={null}
          skillsOnlyInstall={false}
          onDone={() => {}}
        />,
      ),
    );
    expect(
      await screen.findByRole("combobox", { name: "GitHub access" }),
    ).toHaveTextContent("acme-org · org connection");
    expect(screen.queryByRole("button", { name: /Install GitHub/ })).toBeNull();
  });

  describe("a library that lost its access", () => {
    const lost: SkillSource = {
      ...current,
      accessLost: true,
      lastError: "GitHub access lost",
    };

    it("never offers its current access, and picks nothing for you among several", async () => {
      answer([
        orgAccount,
        { ...orgAccount, appConnectionId: "conn-2", account: "other" },
      ]);
      const user = userEvent.setup();
      render(
        wrap(
          <ConnectLibraryForm
            current={lost}
            usage={null}
            skillsOnlyInstall
            onDone={() => {}}
          />,
        ),
      );
      const picker = await screen.findByRole("combobox", {
        name: "GitHub access",
      });
      expect(picker).toHaveTextContent("Pick an account");
      expect(mocks.apiPost).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Reconnect" })).toBeDisabled();
      await user.click(picker);
      expect(
        screen.queryByRole("option", { name: /· current/ }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("option", { name: "other · org connection" }),
      ).toBeInTheDocument();
    });

    it("reconnects through the only org account, keeping repo and branch", async () => {
      answer([orgAccount]);
      mocks.apiPost.mockResolvedValue(reposOf(["acme/skills"]));
      mocks.apiPut.mockResolvedValue({ ...current });
      const onDone = vi.fn();
      const user = userEvent.setup();
      render(
        wrap(
          <ConnectLibraryForm
            current={lost}
            usage={{ skillNames: ["dbt"], agentCount: 1 }}
            skillsOnlyInstall
            onDone={onDone}
          />,
        ),
      );
      await waitFor(() =>
        expect(mocks.apiPost).toHaveBeenCalledWith(
          "/v1/org/skill-library/access/repositories",
          { appConnectionId: "conn-1" },
        ),
      );
      await user.click(
        await screen.findByRole("button", { name: "Reconnect" }),
      );
      // Same repo and branch: nothing is switched, so nothing to confirm.
      await waitFor(() =>
        expect(mocks.apiPut).toHaveBeenCalledWith("/v1/org/skill-library", {
          appConnectionId: "conn-1",
          repo: "acme/skills",
          branch: "main",
        }),
      );
      expect(onDone).toHaveBeenCalled();
    });

    it("with no org account, goes straight to a fresh install", async () => {
      answer([]);
      render(
        wrap(
          <ConnectLibraryForm
            current={lost}
            usage={null}
            skillsOnlyInstall
            onDone={() => {}}
          />,
        ),
      );
      expect(
        await screen.findByRole("button", {
          name: "Install GitHub for skills only",
        }),
      ).toBeTruthy();
    });
  });

  it("'Add it on GitHub' opens the installation the server says the access reaches", async () => {
    answer([orgAccount]);
    mocks.apiPost.mockResolvedValue(
      reposOf(["acme-org/skills"], {
        installationId: "77",
        account: "acme-org",
        accountType: "Organization",
      }),
    );
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const user = userEvent.setup();
    render(
      wrap(
        <ConnectLibraryForm
          current={null}
          usage={null}
          skillsOnlyInstall
          onDone={() => {}}
        />,
      ),
    );
    await user.click(
      await screen.findByRole("button", { name: "Add it on GitHub" }),
    );
    expect(open).toHaveBeenCalledWith(
      "https://github.com/organizations/acme-org/settings/installations/77",
      "github-manage-repos",
      expect.any(String),
    );
  });

  it("after a skills-only install that shares no repo, says so and links to GitHub instead of an empty menu", async () => {
    answer([]);
    mocks.apiPost.mockResolvedValue(
      reposOf([], {
        installationId: "99",
        account: "someone",
        accountType: "User",
      }),
    );
    const popup = { location: { href: "" } };
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(popup as unknown as Window);
    const user = userEvent.setup();
    render(
      wrap(
        <ConnectLibraryForm
          current={null}
          usage={null}
          skillsOnlyInstall
          onDone={() => {}}
        />,
      ),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Install GitHub for skills only",
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: popup as unknown as Window,
        data: { type: "skill-library-github-granted", grant: "signed.grant" },
      }),
    );
    expect(
      await screen.findByText(/No repos shared with OneCLI yet/),
    ).toBeTruthy();
    expect(
      screen.queryByRole("combobox", { name: "Repository" }),
    ).not.toBeInTheDocument();
    open.mockClear();
    await user.click(screen.getByRole("button", { name: "Add one on GitHub" }));
    expect(open).toHaveBeenCalledWith(
      "https://github.com/settings/installations/99",
      "github-manage-repos",
      expect.any(String),
    );
  });

  it("a typed repo that isn't owner/name says how to write it", async () => {
    answer([orgAccount]);
    mocks.apiPost.mockResolvedValue(reposOf(["acme-org/a"], undefined, true));
    const user = userEvent.setup();
    render(
      wrap(
        <ConnectLibraryForm
          current={null}
          usage={null}
          skillsOnlyInstall
          onDone={() => {}}
        />,
      ),
    );
    // Past the listing cap the repo is typed (the menu would be partial).
    const input = await screen.findByPlaceholderText("owner/name");
    expect(screen.queryByText("Use owner/name")).toBeNull();
    await user.type(input, "just-a-name");
    expect(screen.getByText("Use owner/name")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    await user.type(input, "/skills");
    expect(screen.queryByText("Use owner/name")).toBeNull();
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
  });

  it("changing the repo says 'Switch repo…', and the confirm reads the impact fresh", async () => {
    answer([]);
    mocks.apiPost.mockResolvedValue(reposOf(["acme/skills", "acme/other"]));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <ConnectLibraryForm
          current={current}
          usage={usage}
          skillsOnlyInstall
          onDone={() => {}}
        />
      </QueryClientProvider>,
    );
    await user.click(
      await screen.findByRole("combobox", { name: "Repository" }),
    );
    await user.click(await screen.findByRole("option", { name: "acme/other" }));
    await user.click(screen.getByRole("button", { name: "Switch repo…" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: expect.arrayContaining(["skills", "library"]),
        exact: true,
      }),
    );
  });
});
