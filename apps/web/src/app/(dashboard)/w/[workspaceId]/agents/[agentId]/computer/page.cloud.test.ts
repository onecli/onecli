import { describe, expect, it, vi } from "vitest";

// The cloud counterpart of page.onprem.test.ts: the hosted platform serves
// the page, so the self-host refusal is an edition gate, not a dead end.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
});

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/ee/desktop/desktop-theater-page", () => ({
  DesktopTheaterPage: () => null,
}));

const { default: AgentComputerPage } = await import("./page");

describe("Computer page on the hosted platform", () => {
  it("renders the licensed page", () => {
    expect(() => AgentComputerPage()).not.toThrow();
    expect(AgentComputerPage()).toBeTruthy();
  });
});
