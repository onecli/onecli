import { describe, expect, it } from "vitest";
import {
  AGENT_CREATE_PARAM,
  agentChatPath,
  agentChatGreetingPath,
  agentGreetingDraft,
  agentPath,
  agentsCreatePath,
  agentSectionPath,
  connectionsPath,
  hasWorkspaceContext,
  isAgentPagePath,
  matchAgentPage,
  withWorkspacePrefix,
} from "./navigation";

describe("hasWorkspaceContext", () => {
  it("only /w/<id> paths carry a workspace context", () => {
    expect(hasWorkspaceContext("/w/abc")).toBe(true);
    expect(hasWorkspaceContext("/w/abc/agents")).toBe(true);
    expect(hasWorkspaceContext("/")).toBe(false);
    expect(hasWorkspaceContext("/org/o1/global-connections")).toBe(false);
    expect(hasWorkspaceContext("/org/o1/workspaces")).toBe(false);
  });
});

describe("withWorkspacePrefix", () => {
  it("prefixes the target with the current workspace scope", () => {
    expect(withWorkspacePrefix("/w/abc/connections", "/agents")).toBe(
      "/w/abc/agents",
    );
    expect(withWorkspacePrefix("/w/abc", "/install")).toBe("/w/abc/install");
  });

  it("never emits a bare dead path outside a workspace scope", () => {
    // Bare workspace paths (/agents, /connections, ...) 404 everywhere on the
    // org-scoped surface — org context degrades to the org's workspaces list.
    expect(withWorkspacePrefix("/org/o1/global-connections", "/agents")).toBe(
      "/org/o1/workspaces",
    );
    expect(withWorkspacePrefix("/org/o1/settings/team", "/connections")).toBe(
      "/org/o1/workspaces",
    );
    // No org either (account routes, home): fall back to home.
    expect(withWorkspacePrefix("/account/profile", "/install")).toBe("/");
  });
});

describe("agentPath", () => {
  it("resolves inside the workspace scope and degrades elsewhere", () => {
    expect(agentPath("/w/abc/agents", "a1")).toBe("/w/abc/agents/a1");
    expect(agentPath("/org/o1/global-connections", "a1")).toBe(
      "/org/o1/workspaces",
    );
  });

  it("percent-encodes the id so a crafted value cannot splice segments", () => {
    expect(agentPath("/w/abc/agents", "../secrets")).toBe(
      "/w/abc/agents/..%2Fsecrets",
    );
  });
});

describe("agentSectionPath", () => {
  it("appends the section under the agent page", () => {
    expect(agentSectionPath("/w/abc/agents", "a1", "chat")).toBe(
      "/w/abc/agents/a1/chat",
    );
    expect(agentSectionPath("/w/abc/overview", "a1", "apps")).toBe(
      "/w/abc/agents/a1/apps",
    );
  });
});

describe("connectionsPath", () => {
  it("uses an explicit basePath verbatim", () => {
    expect(
      connectionsPath(
        {
          pathname: "/org/o1/global-connections",
          basePath: "/org/o1/global-connections",
        },
        "/apps/github",
      ),
    ).toBe("/org/o1/global-connections/apps/github");
  });

  it("derives the workspace connections root from a /p pathname", () => {
    expect(connectionsPath({ pathname: "/w/abc/connections" })).toBe(
      "/w/abc/connections",
    );
    expect(
      connectionsPath({ pathname: "/w/abc/agents/a1" }, "/vaults/onepassword"),
    ).toBe("/w/abc/connections/vaults/onepassword");
  });

  it("derives the org global-connections root from an /org pathname", () => {
    expect(
      connectionsPath({ pathname: "/org/o1/global-connections/apps/github" }),
    ).toBe("/org/o1/global-connections");
    expect(
      connectionsPath({ pathname: "/org/o1/global-connections" }, "/apps/x"),
    ).toBe("/org/o1/global-connections/apps/x");
  });

  it("falls back to home when the pathname carries no scope", () => {
    expect(connectionsPath({ pathname: "/account/profile" })).toBe("/");
  });
});

describe("matchAgentPage", () => {
  it("reads the agent and its section", () => {
    expect(matchAgentPage("/w/abc/agents/a1")).toEqual({
      agentId: "a1",
      section: "",
    });
    expect(matchAgentPage("/w/abc/agents/a1/chat")).toEqual({
      agentId: "a1",
      section: "chat",
    });
    expect(matchAgentPage("/w/abc/agents/a1/")).toEqual({
      agentId: "a1",
      section: "",
    });
  });

  it("is null off the agent page — the agents LIST included", () => {
    expect(matchAgentPage("/w/abc/agents")).toBeNull();
    expect(matchAgentPage("/w/abc/agents/")).toBeNull();
    expect(matchAgentPage("/w/abc/agentsy/a1")).toBeNull();
    expect(matchAgentPage("/org/o1/agents/a1")).toBeNull();
  });
});

describe("isAgentPagePath", () => {
  it("matches the agent page and every section under it", () => {
    expect(isAgentPagePath("/w/abc/agents/a1")).toBe(true);
    expect(isAgentPagePath("/w/abc/agents/a1/chat")).toBe(true);
    expect(isAgentPagePath("/w/abc/agents/a1/models")).toBe(true);
  });

  it("never matches the agents LIST or non-workspace paths", () => {
    expect(isAgentPagePath("/w/abc/agents")).toBe(false);
    expect(isAgentPagePath("/w/abc/agents/")).toBe(false);
    expect(isAgentPagePath("/w/abc/agentsy/a1")).toBe(false);
    expect(isAgentPagePath("/org/o1/agents/a1")).toBe(false);
  });
});

describe("agentChatPath", () => {
  it("addresses an agent's thread by workspace, not by the current URL", () => {
    expect(agentChatPath("w1", "ag-1")).toBe("/w/w1/agents/ag-1/chat");
  });

  it("encodes both ids so neither can splice extra path segments", () => {
    expect(agentChatPath("w/1", "a/b")).toBe("/w/w%2F1/agents/a%2Fb/chat");
  });
});

describe("agentChatGreetingPath", () => {
  it("carries the greeting flag so the composer opens prefilled", () => {
    expect(agentChatGreetingPath("w1", "ag-1")).toBe(
      "/w/w1/agents/ag-1/chat?hello=1",
    );
  });

  it("keeps the same encoding guarantees as the plain chat path", () => {
    expect(agentChatGreetingPath("w/1", "a/b")).toBe(
      "/w/w%2F1/agents/a%2Fb/chat?hello=1",
    );
  });
});

describe("agentGreetingDraft", () => {
  it("addresses the agent by name", () => {
    expect(agentGreetingDraft("Donna")).toBe(
      "Hey Donna, what can you do for me?",
    );
  });

  it("trims the name so a padded value can't read as a typo", () => {
    expect(agentGreetingDraft("  Donna  ")).toBe(
      "Hey Donna, what can you do for me?",
    );
  });
});

describe("agentsCreatePath", () => {
  it("lands on the workspace roster with the create flow open", () => {
    expect(agentsCreatePath("abc")).toBe(
      `/w/abc/agents?${AGENT_CREATE_PARAM}=1`,
    );
  });

  it("encodes the workspace id so it can't splice extra segments", () => {
    expect(agentsCreatePath("a/b")).toBe(
      `/w/a%2Fb/agents?${AGENT_CREATE_PARAM}=1`,
    );
  });
});
