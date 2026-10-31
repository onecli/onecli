// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillImportCard } from "./skill-import-card";

vi.mock("next/navigation", () => ({
  useParams: () => ({ agentId: "ag-1" }),
  usePathname: () => "/w/ws-1/agents/ag-1/chat",
}));

afterEach(cleanup);

describe("<SkillImportCard />", () => {
  it("says what was added, what's inside, and what was left out", () => {
    render(
      <SkillImportCard
        data={{
          skills: [
            {
              name: "incident-tools",
              files: 22,
              bytes: 987_000,
              groups: { fixtures: 9, playbooks: 7, references: 3, tools: 2 },
              skipped: [{ path: ".DS_Store", reason: "System file" }],
              skippedCount: 1,
              replaced: false,
            },
          ],
          problems: [{ folder: "Bad Name", reason: "Not a valid name" }],
          problemCount: 1,
        }}
      />,
    );
    const card = screen.getByTestId("skill-import-card");
    // jsdom's matcher normalizes the size's non-breaking space.
    expect(card).toHaveTextContent(
      "incident-tools added · 22 files · 963.9 KB",
    );
    expect(card).toHaveTextContent(
      "Instructions, 9 fixtures, 7 playbooks, 3 references, 2 runnable tools",
    );
    expect(card).toHaveTextContent("Left out 1: .DS_Store (system file)");
    expect(card).toHaveTextContent("Bad Name wasn't added: Not a valid name");
    expect(card).not.toHaveTextContent("more not added");
    expect(screen.getByRole("link", { name: "Open skills" })).toHaveAttribute(
      "href",
      "/w/ws-1/agents/ag-1/skills",
    );
  });

  it("says updated when the skill already existed", () => {
    render(
      <SkillImportCard
        data={{
          skills: [
            {
              name: "s",
              files: 1,
              bytes: 10,
              groups: {},
              skipped: [],
              skippedCount: 0,
              replaced: true,
            },
          ],
          problems: [],
          problemCount: 0,
        }}
      />,
    );
    expect(screen.getByTestId("skill-import-card")).toHaveTextContent(
      "s updated · 1 files · 10 B",
    );
  });

  it("names a folder called constructor as itself", () => {
    render(
      <SkillImportCard
        data={{
          skills: [
            {
              name: "s",
              files: 3,
              bytes: 10,
              groups: { constructor: 2 },
              skipped: [],
              skippedCount: 0,
              replaced: false,
            },
          ],
          problems: [],
          problemCount: 0,
        }}
      />,
    );
    expect(screen.getByTestId("skill-import-card")).toHaveTextContent(
      "Instructions, 2 constructor",
    );
  });

  it("counts the problems the result didn't list", () => {
    render(
      <SkillImportCard
        data={{
          skills: [],
          problems: [{ folder: "a", reason: "No name" }],
          problemCount: 4,
        }}
      />,
    );
    expect(screen.getByTestId("skill-import-card")).toHaveTextContent(
      "And 3 more not added.",
    );
    expect(screen.queryByRole("link", { name: "Open skills" })).toBeNull();
  });
});
