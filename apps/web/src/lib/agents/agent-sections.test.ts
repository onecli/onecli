import { describe, expect, it } from "vitest";
import {
  AGENT_SECTIONS,
  AGENT_SECTION_GROUPS,
  agentSectionBlocked,
  agentSectionsFor,
  defaultAgentSection,
  isFullHeightAgentSection,
} from "./agent-sections";

/**
 * The table four surfaces read — the rail renders it, the breadcrumb switcher
 * asks it whether it may hold the current section, the page frame refuses a
 * section this agent cannot have, and the frame asks which section owns the
 * page's height. These are the laws that keep them agreeing.
 */

describe("agentSectionsFor", () => {
  it("gives a hosted agent every section", () => {
    expect(agentSectionsFor("hosted")).toHaveLength(AGENT_SECTIONS.length);
  });

  it("hides chat, instructions, channels, ssh, schedules and memory from a BYO agent — it has none", () => {
    const byo = agentSectionsFor("byo").map((s) => s.section);
    expect(byo).not.toContain("chat");
    expect(byo).not.toContain("instructions");
    // Channels put a HOSTED agent in Slack — a BYO agent has no presence to
    // manage.
    expect(byo).not.toContain("channels");
    // SSH lands in a HOSTED agent's sandbox — a BYO agent has no computer to
    // shell into.
    expect(byo).not.toContain("ssh");
    // Schedules wake a HOSTED agent's sandbox — a BYO agent has no computer
    // the platform can wake.
    expect(byo).not.toContain("schedules");
    // Memory is written by a HOSTED agent's tools — a BYO agent has none.
    expect(byo).not.toContain("memory");
    // Its own page still works: Connections and Models.
    expect(byo).toEqual(["connections", "models"]);
  });
});

describe("agentSectionBlocked", () => {
  it("blocks a hosted-only section for a BYO agent", () => {
    expect(agentSectionBlocked("chat", "byo")).toBe(true);
    expect(agentSectionBlocked("instructions", "byo")).toBe(true);
    expect(agentSectionBlocked("channels", "byo")).toBe(true);
    expect(agentSectionBlocked("ssh", "byo")).toBe(true);
    expect(agentSectionBlocked("schedules", "byo")).toBe(true);
    expect(agentSectionBlocked("memory", "byo")).toBe(true);
  });

  it("blocks nothing for a hosted agent", () => {
    for (const { section } of AGENT_SECTIONS) {
      expect(agentSectionBlocked(section, "hosted")).toBe(false);
    }
  });

  it("never blocks a shared section, or a segment that isn't a section", () => {
    expect(agentSectionBlocked("connections", "byo")).toBe(false);
    // The index is not a section at all — it redirects.
    expect(agentSectionBlocked("", "byo")).toBe(false);
    // An unknown segment is Next's 404, not ours — claiming "hosted only"
    // there would explain a typo with the wrong reason.
    expect(agentSectionBlocked("nonsense", "byo")).toBe(false);
  });
});

describe("isFullHeightAgentSection", () => {
  it("is the chat thread, and only the chat thread", () => {
    expect(isFullHeightAgentSection("chat")).toBe(true);
    for (const { section } of AGENT_SECTIONS.filter(
      (s) => s.section !== "chat",
    )) {
      expect(isFullHeightAgentSection(section)).toBe(false);
    }
  });
});

describe("the rail's shape (§3.18 as amended)", () => {
  it("puts Chat first, then Access, then Behavior", () => {
    const hosted = agentSectionsFor("hosted").map((s) => s.section);
    expect(hosted).toEqual([
      "chat",
      "channels",
      "connections",
      "models",
      "ssh",
      "instructions",
      "skills",
      "schedules",
      "memory",
    ]);
  });

  it("consolidates apps and secrets into one Connections section", () => {
    const sections = AGENT_SECTIONS.map((s) => s.section);
    expect(sections).toContain("connections");
    expect(sections).not.toContain("apps");
    expect(sections).not.toContain("secrets");
  });

  it("keeps Access to exactly what the agent is GIVEN, plus the ways in: connections, models and ssh", () => {
    const access = AGENT_SECTIONS.filter((s) => s.group === "access");
    expect(access.map((s) => s.section)).toEqual([
      "connections",
      "models",
      "ssh",
    ]);
  });

  it("puts everything else under Behavior", () => {
    const behavior = AGENT_SECTIONS.filter((s) => s.group === "behavior");
    expect(behavior.map((s) => s.section)).toEqual([
      "instructions",
      "skills",
      "schedules",
      "memory",
    ]);
  });

  it("renders every section under exactly one declared group, in order", () => {
    const declared = AGENT_SECTION_GROUPS.map((g) => g.group);
    for (const s of AGENT_SECTIONS) expect(declared).toContain(s.group);
    const order = AGENT_SECTIONS.map((s) => declared.indexOf(s.group));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Three titled clusters; ONE section leads visually (prominent), and it
    // is Chat — not its whole cluster, or Slack would falsely lead too.
    expect(AGENT_SECTION_GROUPS.map((g) => g.label)).toEqual([
      "Work",
      "Access",
      "Behavior",
    ]);
    expect(AGENT_SECTIONS.filter((s) => s.prominent)).toHaveLength(1);
    expect(AGENT_SECTIONS.find((s) => s.prominent)?.section).toBe("chat");
  });
});

describe("defaultAgentSection — where the agent index lands", () => {
  it("sends a hosted agent to its thread", () => {
    expect(defaultAgentSection("hosted")).toBe("chat");
  });

  it("sends a BYO agent to Connections — it has no thread", () => {
    expect(defaultAgentSection("byo")).toBe("connections");
  });

  it("always names a section that kind of agent actually has", () => {
    for (const kind of ["hosted", "byo"]) {
      const sections = agentSectionsFor(kind).map((s) => s.section);
      expect(sections).toContain(defaultAgentSection(kind));
      expect(agentSectionBlocked(defaultAgentSection(kind), kind)).toBe(false);
    }
  });

  it("has no Overview section left — the facts are a dialog now", () => {
    expect(AGENT_SECTIONS.map((s) => s.section)).not.toContain("");
    expect(AGENT_SECTIONS.map((s) => s.title)).not.toContain("Overview");
  });
});

describe("Skills belong to the agent (§3.18 as amended)", () => {
  it("is an agent section, hosted-only — a BYO agent has no sandbox to load them", () => {
    const skills = AGENT_SECTIONS.find((s) => s.section === "skills");
    expect(skills?.group).toBe("behavior");
    expect(agentSectionsFor("byo").map((s) => s.section)).not.toContain(
      "skills",
    );
    expect(agentSectionBlocked("skills", "byo")).toBe(true);
    expect(agentSectionBlocked("skills", "hosted")).toBe(false);
  });
});

describe("Slack sits beside Chat (§3.16)", () => {
  it("is a Work entry, not a Behavior one — both are places the agent is reached", () => {
    const slack = AGENT_SECTIONS.find((s) => s.section === "channels");
    expect(slack?.group).toBe("chat");
    expect(
      AGENT_SECTIONS.filter((s) => s.group === "chat").map((s) => s.section),
    ).toEqual(["chat", "channels"]);
  });

  it("is titled for the provider a user recognizes, on the unchanged URL", () => {
    const slack = AGENT_SECTIONS.find((s) => s.section === "channels");
    expect(slack?.title).toBe("Slack");
    // The route stays provider-neutral: the platform layer underneath is a
    // registry, and renaming the URL would break every existing link.
    expect(AGENT_SECTIONS.map((s) => s.section)).not.toContain("slack");
  });

  it("stays hosted-only — a BYO agent has no presence to manage", () => {
    expect(agentSectionBlocked("channels", "byo")).toBe(true);
    expect(agentSectionsFor("byo").map((s) => s.section)).not.toContain(
      "channels",
    );
  });
});

describe("SSH is instance-gated (sandbox-platform step 5)", () => {
  it("is the ONE instance-gated entry, keyed to the instance's ssh capability", () => {
    // The rail hides an `instanceGated` entry when /v1/instance resolves
    // without the capability (auto-hide, never a teased dead door). Exactly
    // one entry carries the gate, and it is SSH — a second one must extend
    // the rail's filter deliberately, not ride this law by accident.
    const gated = AGENT_SECTIONS.filter((s) => s.instanceGated !== undefined);
    expect(gated.map((s) => s.section)).toEqual(["ssh"]);
    expect(gated[0]?.instanceGated).toBe("ssh");
  });

  it("is an Access entry and hosted-only — a BYO agent has no computer to shell into", () => {
    const ssh = AGENT_SECTIONS.find((s) => s.section === "ssh");
    expect(ssh?.group).toBe("access");
    expect(ssh?.hostedOnly).toBe(true);
    expect(agentSectionBlocked("ssh", "byo")).toBe(true);
    expect(agentSectionBlocked("ssh", "hosted")).toBe(false);
  });
});
