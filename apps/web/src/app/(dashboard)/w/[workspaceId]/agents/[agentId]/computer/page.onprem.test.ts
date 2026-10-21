import { describe, expect, it, vi } from "vitest";

// The full-page Computer route is a hosted-platform surface: on a self-host
// the page does not exist (notFound). The edition is read once, when
// @/lib/env loads, so it is cleared before anything imports it.
vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_EDITION;
});

const loaded = vi.hoisted(() => ({ page: false }));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/ee/desktop/desktop-theater-page", () => ({
  DesktopTheaterPage: () => {
    loaded.page = true;
    return null;
  },
}));

const { default: AgentComputerPage } = await import("./page");

describe("Computer page on a self-host", () => {
  it("does not exist", () => {
    expect(() => AgentComputerPage()).toThrow("NEXT_NOT_FOUND");
    expect(loaded.page).toBe(false);
  });
});
