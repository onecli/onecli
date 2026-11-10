// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * The dashboard's waiting screen takes the shape of the URL being opened,
 * so a first load fills in where the page will be: the agent's sidebar and
 * the section's own skeleton on an agent URL, the theater's dark frame for
 * the full-page desktop, the generic shell elsewhere. Never the old
 * centred spinner or "Loading..." text.
 */

const state = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));
vi.mock("next/image", () => ({ default: () => null }));

const { PendingDashboard } = await import("./pending-dashboard");

afterEach(cleanup);

const view = (pathname: string) => {
  state.pathname = pathname;
  return render(<PendingDashboard />).container;
};

describe("PendingDashboard", () => {
  it("draws the chat's thread and composer, and the agent's sidebar, on an agent's Chat", () => {
    const page = view("/w/ws1/agents/ag1/chat");
    expect(screen.getByText("Loading the conversation")).toBeInTheDocument();
    expect(screen.getByTestId("composer-skeleton")).toBeInTheDocument();
    expect(page.querySelector("[data-agent-nav-skeleton]")).not.toBeNull();
  });

  it("draws a page of blocks in the section's scroll shell on any other section", () => {
    const page = view("/w/ws1/agents/ag1/schedules");
    expect(screen.queryByText("Loading the conversation")).toBeNull();
    expect(screen.queryByTestId("composer-skeleton")).toBeNull();
    expect(page.querySelector(".max-w-4xl [aria-busy]")).not.toBeNull();
    expect(page.querySelector("[data-agent-nav-skeleton]")).not.toBeNull();
  });

  it("draws the theater's own dark frame for the desktop, with no shell", () => {
    const page = view("/w/ws1/agents/ag1/computer");
    expect(screen.getByText("Loading agent")).toBeInTheDocument();
    expect(page.querySelector(".bg-black")).not.toBeNull();
    expect(page.querySelector(".bg-canvas")).toBeNull();
  });

  it("leaves the panel empty on the home page, which cannot know its landing yet", () => {
    const page = view("/");
    expect(page.querySelector(".bg-canvas")).not.toBeNull();
    expect(page.querySelector("[data-agent-nav-skeleton]")).not.toBeNull();
    expect(screen.queryByText("Loading the conversation")).toBeNull();
    expect(page.querySelectorAll("[aria-busy]")).toHaveLength(1);
  });

  it("draws the generic shell on an org page", () => {
    const page = view("/org/o1/workspaces");
    expect(page.querySelector(".bg-canvas")).not.toBeNull();
    expect(page.querySelector("[data-agent-nav-skeleton]")).toBeNull();
    expect(page.querySelector(".max-w-6xl [aria-busy]")).not.toBeNull();
  });

  // An old address forwards to a page nobody can name yet (a Settings
  // modal page over the first agent, or a block on a merged page): the
  // landing's picture, not the old org scope or a guessed page of blocks.
  it("draws the landing skeleton on an old address that only forwards", () => {
    for (const path of [
      "/org/o1/team",
      "/org/o1/settings/sso",
      "/w/ws1/connections/llms",
      "/w/ws1/agents/ag1/memory",
      "/account/preferences",
    ]) {
      const page = view(path);
      expect(
        page.querySelector("[data-agent-nav-skeleton]"),
        path,
      ).not.toBeNull();
      expect(page.querySelectorAll("[aria-busy]"), path).toHaveLength(1);
      cleanup();
    }
  });

  it("never falls back to a spinner or loading text", () => {
    for (const path of ["/", "/w/ws1/agents/ag1/chat", "/org/o1"]) {
      const page = view(path);
      expect(page.querySelector(".animate-spin")).toBeNull();
      expect(page.textContent).not.toContain("Loading...");
      cleanup();
    }
  });
});
