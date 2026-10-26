// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentStatusPill, agentStatus } from "./agent-status-pill";

/**
 * The one status element's truth table (§3.18 rule 1 + step 13's held-awake
 * signal): `workingInBackground` folds into the SAME pill — never a second
 * chip — and offline always wins over it (a runner that isn't reporting is
 * the first truth a user needs).
 */
describe("AgentStatusPill", () => {
  it("renders nothing when online and idle — the normal state is not news", () => {
    const { container } = render(<AgentStatusPill availability="ready" />);
    expect(container.textContent).toBe("");
  });

  it("reads Working when ready with live background work", () => {
    render(<AgentStatusPill availability="ready" workingInBackground />);
    expect(screen.getByText("Working")).toBeDefined();
    expect(screen.queryByText("Online")).toBeNull();
  });

  it("offline wins over background work", () => {
    render(<AgentStatusPill availability="offline" workingInBackground />);
    expect(screen.getByText("Offline")).toBeDefined();
    expect(screen.queryByText("Working")).toBeNull();
  });

  it("renders nothing while loading or absent — loading never reads as a status", () => {
    const { container: loading } = render(
      <AgentStatusPill availability="loading" workingInBackground />,
    );
    expect(loading.textContent).toBe("");
    const { container: absent } = render(
      <AgentStatusPill availability="absent" workingInBackground />,
    );
    expect(absent.textContent).toBe("");
  });

  // The rule the Details dialog also reads to decide whether a Status row
  // exists at all.
  it.each([
    ["ready", false, null],
    ["ready", true, "working"],
    ["offline", false, "offline"],
    ["offline", true, "offline"],
    ["loading", true, null],
    ["absent", true, null],
  ] as const)(
    "agentStatus(%s, working=%s) is %s",
    (availability, working, want) => {
      expect(agentStatus(availability, working)).toBe(want);
    },
  );
});
