// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Joining an org from its invitation page is a full navigation (the
 * dashboard rendered without the membership), and it goes straight onto
 * the joined org's first agent: the landing is looked up first, so the
 * load never passes through the org's forwarding URL, which renders the
 * dashboard around its redirect.
 */

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  assign: vi.fn(),
  orgLanding: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
vi.mock("@/lib/dashboard/landing", () => ({ orgLanding: mocks.orgLanding }));
vi.mock("@/hooks/use-invitations", () => ({
  useAcceptInvitation: () => ({ mutate: mocks.mutate, isPending: false }),
}));

const { JoinForm } = await import("./join-form");

const realLocation = window.location;

beforeEach(() => {
  mocks.push.mockReset();
  mocks.assign.mockReset();
  mocks.orgLanding
    .mockReset()
    .mockImplementation(
      async (org: string) => `/w/ws-of-${org}/agents/a1/chat`,
    );
  mocks.mutate
    .mockReset()
    .mockImplementation((_token, opts) =>
      opts.onSuccess({ organizationId: "org-1", organizationName: "Acme" }),
    );
  Object.defineProperty(window, "location", {
    value: { ...realLocation, assign: mocks.assign },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "location", {
    value: realLocation,
    writable: true,
    configurable: true,
  });
});

describe("JoinForm", () => {
  it("lands on the joined org's first agent in one load", async () => {
    const user = userEvent.setup();
    render(<JoinForm token="tok-1" orgName="Acme" />);
    await user.click(screen.getByRole("button", { name: /Join organization/ }));
    await waitFor(() =>
      expect(mocks.assign).toHaveBeenCalledWith(
        "/w/ws-of-org-1/agents/a1/chat",
      ),
    );
    expect(mocks.orgLanding).toHaveBeenCalledWith("org-1");
  });

  it("Decline joins nothing and goes home", async () => {
    const user = userEvent.setup();
    render(<JoinForm token="tok-1" orgName="Acme" />);
    await user.click(screen.getByRole("button", { name: "Decline" }));
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(mocks.assign).not.toHaveBeenCalled();
    expect(mocks.push).toHaveBeenCalledWith("/");
  });
});
