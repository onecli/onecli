import { describe, expect, it } from "vitest";
import {
  extractGitHubOrgAccess,
  findGitHubOrgAccess,
  githubOrgAccessStatus,
  githubOrgAccessSummary,
  githubOrgAdminMessage,
  githubOrgOAuthPolicyUrl,
  githubOrgSsoUrl,
  isGitHubOrgLogin,
} from "./github-org-access";

describe("extractGitHubOrgAccess", () => {
  it("reads the gateway's per-org record, sorted", () => {
    expect(
      extractGitHubOrgAccess({
        username: "octo",
        githubOrgAccess: {
          zeta: { reason: "sso_required", write: false },
          acme: {
            reason: "approval_required",
            write: false,
            endpoint: "repos/acme/api/pulls",
          },
        },
      }),
    ).toEqual([
      { org: "acme", reason: "approval_required" },
      { org: "zeta", reason: "sso_required" },
    ]);
  });

  it("skips malformed entries and tolerates missing metadata", () => {
    expect(extractGitHubOrgAccess(null)).toEqual([]);
    expect(extractGitHubOrgAccess({})).toEqual([]);
    expect(extractGitHubOrgAccess({ githubOrgAccess: [] })).toEqual([]);
    expect(
      extractGitHubOrgAccess({
        githubOrgAccess: {
          ok: { reason: "sso_required" },
          "bad/org": { reason: "sso_required" },
          weird: { reason: "something_else" },
          notobj: "x",
        },
      }),
    ).toEqual([{ org: "ok", reason: "sso_required" }]);
  });
});

describe("findGitHubOrgAccess", () => {
  const record = (id: string, org: string) => ({
    id,
    metadata: { githubOrgAccess: { [org]: { reason: "sso_required" } } },
  });

  it("finds the connection recording the org, case-insensitively", () => {
    const second = record("second", "acme");
    expect(
      findGitHubOrgAccess([{ id: "first", metadata: null }, second], "ACME"),
    ).toEqual({
      connection: second,
      issue: { org: "acme", reason: "sso_required" },
    });
  });

  it("is undefined once no connection records the org", () => {
    expect(findGitHubOrgAccess([record("c", "beta")], "acme")).toBeUndefined();
    expect(findGitHubOrgAccess([], "acme")).toBeUndefined();
  });
});

describe("isGitHubOrgLogin", () => {
  it("accepts GitHub logins and rejects anything else", () => {
    for (const ok of ["acme", "Acme-Labs", "a", "a1-b2"]) {
      expect(isGitHubOrgLogin(ok)).toBe(true);
    }
    for (const bad of ["", "-acme", "acme-", "a/b", "a b", "a".repeat(40)]) {
      expect(isGitHubOrgLogin(bad)).toBe(false);
    }
  });
});

describe("GitHub links and copy", () => {
  it("point at the org's approval and SSO pages", () => {
    expect(githubOrgOAuthPolicyUrl("acme")).toBe(
      "https://github.com/organizations/acme/settings/oauth_application_policy",
    );
    expect(githubOrgSsoUrl("acme")).toBe("https://github.com/orgs/acme/sso");
  });

  it("builds an admin message naming the org and its approval page", () => {
    const message = githubOrgAdminMessage("acme");
    expect(message).toContain("acme");
    expect(message).toContain(githubOrgOAuthPolicyUrl("acme"));
    expect(message).toContain("OneCLI");
  });

  it("labels each reason and summarizes a count", () => {
    expect(githubOrgAccessStatus("approval_required")).toBe(
      "Waiting for admin approval",
    );
    expect(githubOrgAccessStatus("sso_required")).toBe("SSO sign-in needed");
    expect(githubOrgAccessSummary(1)).toBe("1 GitHub org needs access");
    expect(githubOrgAccessSummary(3)).toBe("3 GitHub orgs need access");
  });
});
