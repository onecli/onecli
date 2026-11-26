import { describe, expect, it } from "vitest";
import {
  AGENT_SECTIONS,
  agentSectionBlocked,
  agentSectionsFor,
  defaultAgentSection,
  isFullHeightAgentSection,
  isTheaterAgentSection,
} from "./agent-sections";

/**
 * The table three surfaces read: the sidebar builds its rows from it, the
 * page frame refuses a section this agent cannot have, and the frame asks
 * which section owns the page's height. These are the laws that keep them
 * agreeing.
 */

describe("agentSectionsFor", () => {
  it("gives a hosted agent every section", () => {
    expect(agentSectionsFor("hosted")).toHaveLength(AGENT_SECTIONS.length);
  });

  it("hides the hosted-only sections from a BYO agent", () => {
    const byo = agentSectionsFor("byo").map((s) => s.section);
    // A BYO agent has no thread, no brief, no presence, no computer, no
    // runs. Its own pages still work: Apps, and Agent settings (its model).
    for (const s of [
      "chat",
      "computer",
      "knowledge",
      "contacts",
      "schedules",
      "activity",
      "evals",
      "webhooks",
      "ports",
    ]) {
      expect(byo).not.toContain(s);
    }
    expect(byo).toEqual(["connections", "settings"]);
  });
});

describe("agentSectionBlocked", () => {
  it("blocks a hosted-only section for a BYO agent", () => {
    for (const s of [
      "computer",
      "chat",
      "knowledge",
      "contacts",
      "ports",
      "schedules",
      "webhooks",
      "activity",
      "evals",
    ]) {
      expect(agentSectionBlocked(s, "byo")).toBe(true);
    }
  });

  it("blocks nothing for a hosted agent", () => {
    for (const { section } of AGENT_SECTIONS) {
      expect(agentSectionBlocked(section, "hosted")).toBe(false);
    }
  });

  it("never blocks a shared section, or a segment that isn't a section", () => {
    expect(agentSectionBlocked("connections", "byo")).toBe(false);
    expect(agentSectionBlocked("settings", "byo")).toBe(false);
    // The index is not a section at all: it redirects.
    expect(agentSectionBlocked("", "byo")).toBe(false);
    // An unknown segment is Next's 404, not ours: claiming "hosted only"
    // there would explain a typo with the wrong reason.
    expect(agentSectionBlocked("nonsense", "byo")).toBe(false);
    // The merged-away segments are redirects, not sections: the redirect
    // runs on the server before the frame ever sees them.
    for (const s of ["instructions", "skills", "memory", "channels"]) {
      expect(agentSectionBlocked(s, "byo")).toBe(false);
    }
  });
});

describe("isFullHeightAgentSection", () => {
  it("is the chat thread, while the computer is a standalone theater", () => {
    expect(isFullHeightAgentSection("chat")).toBe(true);
    expect(isFullHeightAgentSection("computer")).toBe(false);
    expect(isTheaterAgentSection("computer")).toBe(true);
    expect(isTheaterAgentSection("chat")).toBe(false);
    expect(isTheaterAgentSection("unknown")).toBe(false);
    for (const { section } of AGENT_SECTIONS.filter(
      (s) => s.section !== "chat" && s.section !== "computer",
    )) {
      expect(isFullHeightAgentSection(section)).toBe(false);
    }
  });
});

describe("the table's shape", () => {
  it("keeps the computer route known without a sidebar row", () => {
    expect(AGENT_SECTIONS.find((s) => s.section === "computer")).toMatchObject({
      theater: true,
      hostedOnly: true,
      instanceGated: "previews",
    });
  });

  it("holds only the merged pages, never the segments that merged into them", () => {
    const sections = AGENT_SECTIONS.map((s) => s.section);
    expect(sections).toEqual([
      "chat",
      "computer",
      "knowledge",
      "connections",
      "contacts",
      "schedules",
      "activity",
      "evals",
      "webhooks",
      "ports",
      "settings",
    ]);
    for (const old of [
      "apps",
      "secrets",
      "instructions",
      "skills",
      "memory",
      "channels",
      "models",
      "ssh",
    ]) {
      expect(sections).not.toContain(old);
    }
  });

  it("gives every kind an Agent settings page (a BYO agent has a model)", () => {
    const settings = AGENT_SECTIONS.find((s) => s.section === "settings");
    expect(settings?.hostedOnly).toBeUndefined();
    expect(agentSectionBlocked("settings", "byo")).toBe(false);
  });
});

describe("defaultAgentSection: where the agent index lands", () => {
  it("sends a hosted agent to its thread", () => {
    expect(defaultAgentSection("hosted")).toBe("chat");
  });

  it("sends a BYO agent to Apps (connections): it has no thread", () => {
    expect(defaultAgentSection("byo")).toBe("connections");
  });

  it("always names a section that kind of agent actually has", () => {
    for (const kind of ["hosted", "byo"]) {
      const sections = agentSectionsFor(kind).map((s) => s.section);
      expect(sections).toContain(defaultAgentSection(kind));
      expect(agentSectionBlocked(defaultAgentSection(kind), kind)).toBe(false);
    }
  });

  it("has no Overview section: the facts live on Agent settings", () => {
    expect(AGENT_SECTIONS.map((s) => s.section)).not.toContain("");
    expect(AGENT_SECTIONS.map((s) => s.section)).not.toContain("overview");
  });
});
