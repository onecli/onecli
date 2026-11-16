import { describe, expect, it } from "vitest";
import {
  workspaceFilePath,
  agentChatPath,
  agentPagePath,
  agentPath,
  agentComputerPath,
  agentSectionPath,
  connectionsPath,
  hasWorkspaceContext,
  isAgentPagePath,
  isDashboardPath,
  isOrgScopedPath,
  matchAgentPage,
  MERGED_AGENT_SECTIONS,
  mergedAgentPagePath,
  mergedSectionPath,
  orgHomePath,
  orgPath,
  withWorkspacePrefix,
  workspacePath,
} from "./navigation";

describe("isDashboardPath", () => {
  it("is the home page and every workspace, org and account URL", () => {
    for (const path of [
      "/",
      "/w/abc",
      "/w/abc/agents/ag/chat",
      "/org/o1/workspaces",
      "/org",
      "/account",
      "/account/ssh-keys",
    ]) {
      expect(isDashboardPath(path)).toBe(true);
    }
  });

  it("is never a sign-in, onboarding or join page, nor a look-alike prefix", () => {
    for (const path of [
      "/auth/login",
      "/auth/signup",
      "/onboarding",
      "/join",
      "/create-org",
      "/slack/installed",
      "/workspaces",
      "/organic",
      "/accounts",
    ]) {
      expect(isDashboardPath(path)).toBe(false);
    }
  });
});

describe("isOrgScopedPath", () => {
  it("is every workspace and org URL, and never the account's", () => {
    expect(isOrgScopedPath("/w/abc/agents/a1/chat")).toBe(true);
    expect(isOrgScopedPath("/org/o1/skills")).toBe(true);
    expect(isOrgScopedPath("/org/o1")).toBe(true);
    expect(isOrgScopedPath("/account")).toBe(false);
    expect(isOrgScopedPath("/account/preferences")).toBe(false);
    expect(isOrgScopedPath("/")).toBe(false);
    expect(isOrgScopedPath("/org")).toBe(false);
    expect(isOrgScopedPath("/workspaces")).toBe(false);
  });
});

describe("hasWorkspaceContext", () => {
  it("only /w/<id> paths carry a workspace context", () => {
    expect(hasWorkspaceContext("/w/abc")).toBe(true);
    expect(hasWorkspaceContext("/w/abc/agents")).toBe(true);
    expect(hasWorkspaceContext("/")).toBe(false);
    expect(hasWorkspaceContext("/org/o1/settings/global-connections")).toBe(
      false,
    );
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
    expect(
      withWorkspacePrefix("/org/o1/settings/global-connections", "/agents"),
    ).toBe("/org/o1/workspaces");
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
    expect(agentPath("/org/o1/settings/global-connections", "a1")).toBe(
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
    expect(agentSectionPath("/w/abc/activity", "a1", "apps")).toBe(
      "/w/abc/agents/a1/apps",
    );
  });
});

// A link to an old agent section goes straight to its block on the merged
// page; the old URL's redirect would get there too, one round trip later.
describe("mergedSectionPath", () => {
  it("lands on the block's anchor on its new page", () => {
    expect(mergedSectionPath("/w/abc/agents/a1/chat", "a1", "skills")).toBe(
      "/w/abc/agents/a1/knowledge#skills",
    );
    expect(mergedSectionPath("/w/abc/agents/a1/chat", "a1", "models")).toBe(
      "/w/abc/agents/a1/settings#models",
    );
    // Slack is Contacts' first block: no anchor, so the page header stays.
    expect(mergedSectionPath("/w/abc/agents/a1/chat", "a1", "channels")).toBe(
      "/w/abc/agents/a1/contacts",
    );
  });

  it("puts a query before the anchor", () => {
    expect(mergedAgentPagePath("ws", "a1", "skills", "connected=slack")).toBe(
      "/w/ws/agents/a1/knowledge?connected=slack#skills",
    );
    expect(mergedAgentPagePath("ws", "a1", "channels", "connected=slack")).toBe(
      "/w/ws/agents/a1/contacts?connected=slack",
    );
  });

  it("encodes ids, like every builder", () => {
    expect(mergedAgentPagePath("ws", "a/b", "ssh")).toBe(
      "/w/ws/agents/a%2Fb/settings#ssh",
    );
  });

  it("never points at a page that is itself a redirect", () => {
    const old = Object.keys(MERGED_AGENT_SECTIONS);
    for (const { page } of Object.values(MERGED_AGENT_SECTIONS)) {
      expect(old).not.toContain(page);
    }
  });
});

describe("agentComputerPath", () => {
  it("is the Computer section, deep-linked to an ask when one is given", () => {
    expect(agentComputerPath("/w/abc/agents/a1/skills", "a1")).toBe(
      "/w/abc/agents/a1/computer",
    );
    expect(
      agentComputerPath(
        "/w/abc/agents/a1/skills",
        "a1",
        "0b4a1c5e-1111-4222-8333-444455556666",
      ),
    ).toBe(
      "/w/abc/agents/a1/computer?takeover=0b4a1c5e-1111-4222-8333-444455556666",
    );
  });

  it("encodes the ask id, so it can never add a param or a path segment", () => {
    expect(agentComputerPath("/w/abc/agents", "a1", "x&y=1/z")).toBe(
      "/w/abc/agents/a1/computer?takeover=x%26y%3D1%2Fz",
    );
  });
});

describe("connectionsPath", () => {
  it("uses an explicit basePath verbatim", () => {
    expect(
      connectionsPath(
        {
          pathname: "/org/o1/settings/global-connections",
          basePath: "/org/o1/settings/global-connections",
        },
        "/apps/github",
      ),
    ).toBe("/org/o1/settings/global-connections/apps/github");
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
      connectionsPath({
        pathname: "/org/o1/settings/global-connections/apps/github",
      }),
    ).toBe("/org/o1/settings/global-connections");
    expect(
      connectionsPath(
        { pathname: "/org/o1/settings/global-connections" },
        "/apps/x",
      ),
    ).toBe("/org/o1/settings/global-connections/apps/x");
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

describe("workspaceFilePath", () => {
  it("addresses one file at the workspace level, with the conversation as a query param", () => {
    expect(workspaceFilePath("w1", "att-1", "cv-1")).toBe(
      "/w/w1/files/att-1?c=cv-1",
    );
  });

  it("encodes every id — a crafted one cannot splice segments or a second param", () => {
    expect(workspaceFilePath("w/1", "x/../y", "cv&c=evil")).toBe(
      "/w/w%2F1/files/x%2F..%2Fy?c=cv%26c%3Devil",
    );
  });
});

describe("route builders", () => {
  it("orgPath: the org root and every page under it", () => {
    expect(orgPath("o1")).toBe("/org/o1");
    expect(orgPath("o1", "team")).toBe("/org/o1/team");
    expect(orgPath("o1", "settings/global-connections")).toBe(
      "/org/o1/settings/global-connections",
    );
  });

  it("orgHomePath: where 'go to this org' lands today (the workspaces list)", () => {
    expect(orgHomePath("o1")).toBe("/org/o1/workspaces");
    // The pathname-derived degrade of withWorkspacePrefix is the same door.
    expect(withWorkspacePrefix("/org/o1/team", "/x")).toBe(orgHomePath("o1"));
  });

  it("workspacePath: the workspace root and every page under it", () => {
    expect(workspacePath("w1")).toBe("/w/w1");
    expect(workspacePath("w1", "agents")).toBe("/w/w1/agents");
    expect(workspacePath("w1", "settings/install")).toBe(
      "/w/w1/settings/install",
    );
  });

  it("agentPagePath: the agent index and a section under it", () => {
    expect(agentPagePath("w1", "a1")).toBe("/w/w1/agents/a1");
    expect(agentPagePath("w1", "a1", "channels")).toBe(
      "/w/w1/agents/a1/channels",
    );
    // The two agent-chat doors agree.
    expect(agentPagePath("w1", "a1", "chat")).toBe(agentChatPath("w1", "a1"));
  });

  it("encodes every id so a crafted one cannot splice extra segments", () => {
    expect(orgPath("o/1", "team")).toBe("/org/o%2F1/team");
    expect(workspacePath("w/1", "agents")).toBe("/w/w%2F1/agents");
    expect(agentPagePath("w/1", "a/../b", "chat")).toBe(
      "/w/w%2F1/agents/a%2F..%2Fb/chat",
    );
  });
});
