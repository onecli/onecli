// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guideHref } from "@/lib/components/setup-guide-link";
import { ConnectFlow } from "./connect-flow";

vi.mock("@/lib/api-fetch", () => ({
  API_ORIGIN: "http://api.test",
  getAuthToken: vi.fn().mockResolvedValue(null),
  getWorkspaceId: () => "ws-1",
}));

const baseApp = {
  id: "monday",
  name: "monday.com",
  icon: "/icons/monday.svg",
  connectionType: "oauth",
};

const note = {
  text: "Only an account admin can install OneCLI.",
  fallback: "Not an admin? Ask yours to install it first.",
  link: {
    url: "https://onecli.sh/docs/integrations/monday#not-an-admin",
    label: "How to get it installed",
  },
};

// Navigation is a real redirect, so the suite watches `window.location.href`
// assignments instead of letting jsdom try to follow them.
const fakeLocation = { href: "http://localhost/" };

describe("ConnectFlow ready screen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeLocation.href = "http://localhost/";
    vi.stubGlobal("location", fakeLocation);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const advance = async (ms: number) => {
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
  };

  it("renders the connect note as separate lines with its docs link in a new tab", () => {
    render(<ConnectFlow app={{ ...baseApp, connectNote: note }} hasDefaults />);
    const paragraphs = screen.getByTestId("connect-note").querySelectorAll("p");
    expect(Array.from(paragraphs, (p) => p.textContent)).toEqual([
      note.text,
      note.fallback,
    ]);
    const link = screen.getByRole("link", { name: note.link.label });
    expect(link.getAttribute("href")).toBe(note.link.url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  // The note is a prerequisite the user must read, so it must not be
  // replaced by an automatic redirect three seconds later.
  it("does not auto-redirect or count down when a note is shown", async () => {
    render(<ConnectFlow app={{ ...baseApp, connectNote: note }} hasDefaults />);
    expect(screen.queryByText(/Auto-connecting/)).toBeNull();
    await advance(5000);
    expect(fakeLocation.href).toBe("http://localhost/");
    expect(screen.queryByText(/Auto-connecting/)).toBeNull();
  });

  // An OAuth app with an API-key alternate (Attio) never auto-redirects, so
  // it must not promise to: the label used to sit at "Auto-connecting in 3s"
  // forever because only the timer checked for the alternate.
  it("does not show a countdown that never runs for an API-key alternate", async () => {
    render(
      <ConnectFlow
        app={{
          ...baseApp,
          apiKeyFields: [{ name: "token", label: "Token", placeholder: "…" }],
        }}
        hasDefaults
      />,
    );
    expect(screen.queryByText(/Auto-connecting/)).toBeNull();
    await advance(5000);
    expect(fakeLocation.href).toBe("http://localhost/");
    expect(screen.queryByText(/Auto-connecting/)).toBeNull();
  });

  it("still auto-redirects a plain OAuth app after the countdown", async () => {
    render(<ConnectFlow app={baseApp} hasDefaults />);
    expect(screen.queryByTestId("connect-note")).toBeNull();
    expect(screen.getByText("Auto-connecting in 3s")).toBeTruthy();
    await advance(3500);
    expect(fakeLocation.href).toContain(
      "http://api.test/v1/apps/monday/authorize",
    );
    // A workspace connect names no agent: the account lands on for none.
    expect(new URL(fakeLocation.href).searchParams.has("agent_id")).toBe(false);
  });

  it("carries the connecting agent to authorize, so the account lands on for it", async () => {
    render(
      <ConnectFlow
        app={baseApp}
        hasDefaults
        agentName="Arik"
        agentId="agent-7"
      />,
    );
    await advance(3500);
    const params = new URL(fakeLocation.href).searchParams;
    expect(params.get("agent_id")).toBe("agent-7");
    expect(params.get("agent_name")).toBe("Arik");
  });

  const accessLevels = {
    label: "Access level",
    defaultValue: "workspace",
    options: [
      {
        value: "workspace",
        label: "Workspace access",
        description: "Acts for the whole workspace.",
      },
      { value: "user", label: "Personal access", description: "Acts as you." },
    ],
  };

  it("shows the access level picker defaulting to workspace access, without auto-redirecting", async () => {
    render(<ConnectFlow app={{ ...baseApp, accessLevels }} hasDefaults />);
    const group = screen.getByRole("radiogroup", { name: "Access level" });
    expect(
      screen.getByRole("radio", { name: "Workspace access" }),
    ).toBeChecked();
    // Both options explain themselves up front, so they can be compared.
    expect(group.textContent).toContain("Acts for the whole workspace.");
    expect(group.textContent).toContain("Acts as you.");
    expect(screen.queryByText(/Auto-connecting/)).toBeNull();
    await advance(5000);
    expect(fakeLocation.href).toBe("http://localhost/");
  });

  it("sends the chosen access level to authorize", async () => {
    render(<ConnectFlow app={{ ...baseApp, accessLevels }} hasDefaults />);
    await act(async () => {
      screen.getByRole("radio", { name: "Personal access" }).click();
    });
    expect(
      screen.getByRole("radio", { name: "Personal access" }),
    ).toBeChecked();
    await act(async () => {
      screen.getByRole("button", { name: /Connect to/ }).click();
    });
    expect(new URL(fakeLocation.href).searchParams.get("access_level")).toBe(
      "user",
    );
  });

  // A radio group is one Tab stop, and the arrow keys move between options.
  // (Radix selects on that move while the key is down, which jsdom's event
  // timing can't reproduce; the browser check covers the selection.)
  it("is one Tab stop whose arrow keys move between the options", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    render(<ConnectFlow app={{ ...baseApp, accessLevels }} hasDefaults />);
    await user.tab(); // the setup guide is absent: the group is first
    expect(
      screen.getByRole("radio", { name: "Workspace access" }),
    ).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(
        screen.getByRole("radio", { name: "Personal access" }),
      ).toHaveFocus(),
    );
    await user.tab();
    expect(screen.getByRole("button", { name: /Connect to/ })).toHaveFocus();
  });

  it("omits the picker and the param for apps without access levels", async () => {
    render(<ConnectFlow app={baseApp} hasDefaults />);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    await advance(3500);
    expect(new URL(fakeLocation.href).searchParams.has("access_level")).toBe(
      false,
    );
  });

  // The callback's partial-grant landing: the popup stays open to say what
  // wasn't granted, and "Try again" re-authenticates the same connection.
  it("keeps a partial grant open and retries on the same connection", async () => {
    render(
      <ConnectFlow
        app={baseApp}
        hasDefaults
        status="success"
        connectionId="conn-1"
        workspaceId="ws-2"
        missingPermissions={[
          { scope: "boards:write", name: "Boards", description: "Edit" },
        ]}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("“Boards”");
    await advance(5000);
    expect(fakeLocation.href).toBe("http://localhost/");

    await act(async () => {
      screen.getByRole("button", { name: "Try again" }).click();
    });
    const params = new URL(fakeLocation.href).searchParams;
    expect(params.get("connectionId")).toBe("conn-1");
    expect(params.get("_workspace")).toBe("ws-2");
  });

  it("links the setup guide on the ready screen", () => {
    render(
      <ConnectFlow
        app={{
          ...baseApp,
          setupGuideUrl: "https://onecli.sh/docs/integrations/monday",
        }}
        hasDefaults
      />,
    );
    const guide = screen.getByRole("link", {
      name: /Follow the monday\.com setup guide/,
    });
    expect(guide.getAttribute("href")).toBe(
      guideHref("https://onecli.sh/docs/integrations/monday"),
    );
  });
});

// When an app has no OneCLI client (own-app on Cloud, every OAuth app on open
// source), the user lands on "Configuration required". That is where they are
// stuck, so the guide must be right there.
describe("ConnectFlow configuration required", () => {
  it("shows the setup guide next to Configure credentials", () => {
    render(
      <ConnectFlow
        app={{
          ...baseApp,
          setupGuideUrl: "https://onecli.sh/docs/integrations/monday",
        }}
        hasDefaults={false}
      />,
    );
    expect(screen.getByText("Configuration required")).toBeTruthy();
    const guide = screen.getByRole("link", {
      name: /Follow the monday\.com setup guide/,
    });
    expect(guide.getAttribute("href")).toBe(
      guideHref("https://onecli.sh/docs/integrations/monday"),
    );
    expect(guide.getAttribute("target")).toBe("_blank");
  });

  it("shows no guide when the app has no docs page", () => {
    render(<ConnectFlow app={baseApp} hasDefaults={false} />);
    expect(screen.getByText("Configuration required")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /setup guide/ })).toBeNull();
  });
});
