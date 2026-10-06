// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  });
});
