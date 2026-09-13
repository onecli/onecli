// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OrgSwitcher } from "./org-switcher";
import { NavUser } from "./nav-user";
import { SidebarProvider } from "@onecli/ui/components/sidebar";

const state = vi.hoisted(() => ({
  orgs: [
    { id: "o1", name: "First org", slug: "first", role: "owner" },
    { id: "o2", name: "Second org", slug: "second", role: "member" },
  ],
  activeOrgId: "o1" as string | null,
  isLoading: false,
  isMobile: false,
  push: vi.fn(),
  setActiveOrgId: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@/lib/dashboard/use-active-org", () => ({
  useActiveOrg: () => ({
    ...state,
    activeOrg: state.orgs.find((org) => org.id === state.activeOrgId),
  }),
}));
vi.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({
    user: { name: "Test User", email: "test@example.com" },
    signOut: state.signOut,
  }),
}));
vi.mock("@onecli/ui/components/sidebar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@onecli/ui/components/sidebar")>()),
  useSidebar: () => ({ isMobile: state.isMobile, state: "expanded" }),
}));

window.matchMedia = vi.fn().mockImplementation((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  dispatchEvent: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.activeOrgId = "o1";
  state.isLoading = false;
  state.isMobile = false;
});

const renderNavUser = () =>
  render(
    <SidebarProvider>
      <NavUser />
    </SidebarProvider>,
  );

// jsdom has no layout. Skip synthetic hover movement between the parent and
// submenu: Radix's pointer-grace geometry otherwise closes it before the click.
describe("header organization switcher", () => {
  it("names the active organization and switches organizations", async () => {
    const user = userEvent.setup({ skipHover: true });
    render(<OrgSwitcher />);
    const trigger = screen.getByRole("button", {
      name: "First org, switch organization",
    });
    expect(trigger).toHaveTextContent("First org");
    await user.click(trigger);
    expect(
      screen
        .getByRole("menuitem", { name: /First org/ })
        .querySelector(".lucide-check"),
    ).not.toBeNull();
    expect(
      screen.getByRole("menuitem", { name: /Create organization/ }),
    ).toHaveAttribute("href", "/create-org");
    await user.click(screen.getByRole("menuitem", { name: /Second org/ }));
    expect(state.setActiveOrgId).toHaveBeenCalledWith("o2");
    expect(state.push).toHaveBeenCalledWith("/org/o2/workspaces");
  });

  it("follows the active organization when it changes", () => {
    const view = render(<OrgSwitcher />);
    state.activeOrgId = "o2";
    view.rerender(<OrgSwitcher />);
    expect(
      screen.getByRole("button", { name: "Second org, switch organization" }),
    ).toBeInTheDocument();
  });

  it("does not navigate when selecting the current organization", async () => {
    const user = userEvent.setup({ skipHover: true });
    render(<OrgSwitcher />);
    await user.click(screen.getByRole("button"));
    await user.click(screen.getByRole("menuitem", { name: /First org/ }));
    expect(state.push).not.toHaveBeenCalled();
    expect(state.setActiveOrgId).not.toHaveBeenCalled();
  });

  it("shows a loading placeholder and hides the switcher without an active org", () => {
    state.isLoading = true;
    const view = render(<OrgSwitcher />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    state.isLoading = false;
    state.activeOrgId = null;
    view.rerender(<OrgSwitcher />);
    expect(view.container).toBeEmptyDOMElement();
  });
});

describe("footer account menu", () => {
  it("leads with the user and shows the organization with its role", async () => {
    const user = userEvent.setup({ skipHover: true });
    renderNavUser();
    const trigger = screen.getByRole("button", { name: /Test User/ });
    expect(trigger).toHaveTextContent("test@example.com");
    await user.click(trigger);

    const orgRow = screen.getByRole("menuitem", { name: /Organization/ });
    expect(orgRow).toHaveTextContent("First org");
    expect(within(orgRow).getByText("owner")).toBeInTheDocument();
    // Organization block sits above the account block.
    const menu = screen.getByRole("menu");
    expect(
      orgRow.compareDocumentPosition(within(menu).getByText("Test User")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: /Account preferences/ }),
    ).toHaveAttribute("href", "/account/preferences");
    expect(
      screen.getByRole("menuitem", { name: /Sign out/ }),
    ).toBeInTheDocument();
  });

  it("supports keyboard organization switching", async () => {
    const user = userEvent.setup();
    renderNavUser();
    await user.tab();
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("menuitem", { name: /Organization/ }),
    ).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(
      await screen.findByRole("menuitem", { name: /First org/, current: true }),
    ).toHaveFocus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(state.push).toHaveBeenCalledWith("/org/o2/workspaces");
  });

  it.each([false, true])(
    "switches organizations from the submenu (mobile=%s)",
    async (isMobile) => {
      state.isMobile = isMobile;
      const user = userEvent.setup({ skipHover: true });
      renderNavUser();
      await user.click(screen.getByRole("button", { name: /Test User/ }));
      await user.click(screen.getByRole("menuitem", { name: /Organization/ }));
      expect(
        await screen.findByRole("menuitem", { name: /Second org/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("menuitem", { name: /Create organization/ }),
      ).toHaveAttribute("href", "/create-org");
      await user.click(screen.getByRole("menuitem", { name: /Second org/ }));
      expect(state.push).toHaveBeenCalledWith("/org/o2/workspaces");
    },
  );

  it("omits the organization block and keeps sign-out without an active organization", async () => {
    state.activeOrgId = null;
    const user = userEvent.setup({ skipHover: true });
    renderNavUser();
    await user.click(screen.getByRole("button", { name: /Test User/ }));
    expect(
      screen.queryByRole("menuitem", { name: /Organization/ }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: /Sign out/ }));
    expect(state.signOut).toHaveBeenCalledOnce();
  });
});
