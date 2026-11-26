// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// App availability sells from Scale, but a rule naming a directory GROUP
// still needs Enterprise (the save route re-checks). The picker must say so
// instead of silently dropping groups, never fetch the admin-only groups list
// while locked, and send the user to the same Groups gate every other group
// surface uses.

const state = vi.hoisted(() => ({
  groupsLocked: false,
  groupsEnabled: [] as boolean[],
  guarded: [] as string[],
}));

vi.mock("@/lib/plan-gate", () => ({
  usePlanGate: () => ({
    isLocked: (feature: string) => feature === "groups" && state.groupsLocked,
    guard: (feature: string) => {
      state.guarded.push(feature);
      return true;
    },
  }),
}));

vi.mock("@/hooks/use-groups", () => ({
  useGroups: (enabled: boolean) => {
    state.groupsEnabled.push(enabled);
    return {
      data: enabled
        ? [{ id: "g1", name: "Engineering", memberCount: 4, source: "manual" }]
        : undefined,
    };
  },
}));

vi.mock("@/hooks/use-org-members", () => ({
  useOrgMembersList: () => ({
    data: [
      {
        userId: "u1",
        email: "ada@example.com",
        name: "Ada",
        status: "active",
      },
    ],
  }),
}));

import { IdentityMultiSelect } from "./identity-multi-select";

const renderPicker = () =>
  render(
    <IdentityMultiSelect userIds={[]} groupIds={[]} onChange={() => {}} />,
  );

beforeEach(() => {
  state.groupsLocked = false;
  state.groupsEnabled = [];
  state.guarded = [];
});
afterEach(cleanup);

describe("IdentityMultiSelect", () => {
  it("entitled to groups: offers people AND groups, no Enterprise hint", () => {
    renderPicker();
    fireEvent.click(
      screen.getByRole("button", { name: "Add people or groups" }),
    );
    expect(screen.getByText("Engineering")).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.queryByText(/Enterprise feature/)).toBeNull();
    expect(state.groupsEnabled.every(Boolean)).toBe(true);
  });

  it("groups locked: people only, the groups read never runs, and the hint explains why", () => {
    state.groupsLocked = true;
    renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "Add people" }));
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.queryByText("Engineering")).toBeNull();
    expect(state.groupsEnabled.every((enabled) => !enabled)).toBe(true);
    expect(
      screen.getByText("Targeting groups is an Enterprise feature."),
    ).toBeInTheDocument();
  });

  it("the hint's action opens the Groups gate", () => {
    state.groupsLocked = true;
    renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "Add people" }));
    fireEvent.click(screen.getByRole("button", { name: "Learn more" }));
    expect(state.guarded).toEqual(["groups"]);
  });
});
