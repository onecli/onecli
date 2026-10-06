import { describe, expect, it } from "vitest";
import {
  activeSettingsItem,
  getNavItems,
  getSettingsSections,
  getWorkspaceSettingsSections,
  workspaceNavItems,
} from "./nav-config";
import { orgConnectionsPath } from "./navigation";

/**
 * The §3.13 truth table for the hosted-only nav entries (Skills, step 9):
 * hidden exactly when the sidebar KNOWS the deployment shows no hosted
 * surface; present by default so the breadcrumb resolver — which has no
 * availability read — keeps resolving the section title.
 */

const workspaceTitles = (opts?: { sidebar?: boolean }) =>
  workspaceNavItems("p1", opts).map((item) => item.title);

describe("workspaceNavItems", () => {
  it("has NO workspace-level Skills entry — skills belong to the agent", () => {
    expect(workspaceTitles()).not.toContain("Skills");
    expect(workspaceTitles({ sidebar: true })).not.toContain("Skills");
  });
});

describe("org nav and the hosted gate", () => {
  const flatTitles = (opts?: Parameters<typeof getNavItems>[1]) =>
    getNavItems("org-1", opts)
      .flat()
      .map((item) => item.title);

  // The Groups entitlement-visibility truth table is LANE-SPECIFIC (it turns
  // on `CAPS.rbac`, frozen at module load), so it cannot live in this file —
  // which runs under whatever edition the CI lane sets. It has pinned twins:
  // nav-config.onprem.test.ts and nav-config.cloud.test.ts.

  it("shows org Skills by default and hides it when hosted is false", () => {
    expect(flatTitles()).toContain("Skills");
    expect(flatTitles({ hosted: false })).not.toContain("Skills");
  });

  it("keeps the Skills URL under the org prefix", () => {
    const skills = getNavItems("org-1")
      .flat()
      .find((item) => item.title === "Skills");
    expect(skills?.url).toBe("/org/org-1/skills");
  });
});

describe("App Availability lives under Organization Settings", () => {
  it("is a settings entry, not a top-level org nav entry", () => {
    const settingsTitles = getSettingsSections("org-1")
      .flatMap((section) => section.items)
      .map((item) => item.title);
    expect(settingsTitles).toContain("App Availability");

    const orgTitles = getNavItems("org-1", { entitled: true })
      .flat()
      .map((item) => item.title);
    expect(orgTitles).not.toContain("App Availability");
  });

  it("points at the settings URL", () => {
    const item = getSettingsSections("org-1")
      .flatMap((section) => section.items)
      .find((entry) => entry.title === "App Availability");
    expect(item?.url).toBe("/org/org-1/settings/app-availability");
  });
});

describe("Global Connections and Global Policy live under Organization Settings", () => {
  const settingsItems = () =>
    getSettingsSections("org-1").flatMap((section) => section.items);
  const orgTitles = () =>
    getNavItems("org-1", { entitled: true })
      .flat()
      .map((item) => item.title);

  it("are settings entries, not top-level org nav entries", () => {
    const titles = settingsItems().map((item) => item.title);
    expect(titles).toContain("Global Connections");
    expect(titles).toContain("Global Policy");
    expect(orgTitles()).not.toContain("Global Connections");
    expect(orgTitles()).not.toContain("Global Policy");
  });

  it("point at the settings URLs", () => {
    const byTitle = (title: string) =>
      settingsItems().find((entry) => entry.title === title)?.url;
    expect(byTitle("Global Connections")).toBe(
      "/org/org-1/settings/global-connections",
    );
    expect(byTitle("Global Policy")).toBe("/org/org-1/settings/policy");
  });

  it("the nav entry and the connections components share ONE root", () => {
    // The tabs, apps grid, connected rows and app back-link all build on
    // orgConnectionsPath; the nav entry drifting from it is how the moved
    // section once kept linking to the old top-level URL.
    const entry = settingsItems().find(
      (item) => item.title === "Global Connections",
    );
    expect(entry?.url).toBe(orgConnectionsPath("org-1"));
  });

  it("drops the retired Domains and Encryption entries", () => {
    const titles = settingsItems().map((item) => item.title);
    expect(titles).not.toContain("Domains");
    expect(titles).not.toContain("Encryption");
  });
});

describe("activeSettingsItem", () => {
  const sections = getSettingsSections("org-1");
  const active = (pathname: string) =>
    activeSettingsItem(sections, pathname)?.title;

  it("keeps the entry active on every page below it", () => {
    const root = "/org/org-1/settings/global-connections";
    expect(active(root)).toBe("Global Connections");
    expect(active(`${root}/custom`)).toBe("Global Connections");
    expect(active(`${root}/connected`)).toBe("Global Connections");
    expect(active(`${root}/apps/github`)).toBe("Global Connections");
  });

  it("matches on a segment boundary, never a bare string prefix", () => {
    expect(active("/org/org-1/settings/policy")).toBe("Global Policy");
    expect(active("/org/org-1/settings/policy-archive")).toBeUndefined();
  });

  it("is undefined outside the settings tree", () => {
    expect(active("/org/org-1/workspaces")).toBeUndefined();
    expect(active("/org/org-1/settings")).toBeUndefined();
  });

  it("resolves workspace settings the same way", () => {
    const ws = getWorkspaceSettingsSections("w1");
    expect(activeSettingsItem(ws, "/w/w1/settings/install")?.title).toBe(
      "Install",
    );
  });
});

describe("Channels sits at the org level, not in settings", () => {
  const orgItems = (opts?: Parameters<typeof getNavItems>[1]) =>
    getNavItems("org-1", opts).flat();

  it("is an org nav entry, not a settings entry", () => {
    expect(orgItems().map((item) => item.title)).toContain("Channels");

    const settingsTitles = getSettingsSections("org-1")
      .flatMap((section) => section.items)
      .map((item) => item.title);
    expect(settingsTitles).not.toContain("Channels");
  });

  it("points at the org-level URL", () => {
    const item = orgItems().find((entry) => entry.title === "Channels");
    expect(item?.url).toBe("/org/org-1/channels");
  });

  it("hides on a runnerless deployment, like Skills", () => {
    const titles = orgItems({ hosted: false }).map((item) => item.title);
    expect(titles).not.toContain("Channels");
    expect(titles).not.toContain("Skills");
  });
});

describe("Agents moves into the sidebar's own group", () => {
  it("is dropped from the sidebar's copy of the workspace nav", () => {
    expect(workspaceTitles({ sidebar: true })).not.toContain("Agents");
  });

  it("stays in the table for the breadcrumb resolver", () => {
    expect(workspaceTitles()).toContain("Agents");
    expect(
      workspaceNavItems("p1").find((item) => item.title === "Agents")?.url,
    ).toBe("/w/p1/agents");
  });
});

describe("Files is a breadcrumb-only section", () => {
  it("never renders in the sidebar (there is no listing to open)", () => {
    expect(workspaceTitles({ sidebar: true })).not.toContain("Files");
  });

  it("stays in the table so the file page's crumb reads Files", () => {
    expect(
      workspaceNavItems("p1").find((item) => item.title === "Files")?.url,
    ).toBe("/w/p1/files");
  });
});

describe("Install moved into Workspace Settings", () => {
  it("is no longer a top-level workspace nav entry", () => {
    expect(workspaceTitles()).not.toContain("Install");
    expect(workspaceTitles({ sidebar: true })).not.toContain("Install");
  });

  it("has no route left at the old top-level path", () => {
    // The route MOVED — the directory is gone, so anything still pushing
    // `/w/<id>/install` now depends on a next.config redirect rather than a
    // real page. Every in-app caller must name the new path directly.
    const urls = getWorkspaceSettingsSections("p1")
      .flatMap((s) => s.items)
      .map((i) => i.url);
    expect(urls).not.toContain("/w/p1/install");
  });

  it("is a workspace settings section, beside General", () => {
    const items = getWorkspaceSettingsSections("p1").flatMap((s) => s.items);
    expect(items.map((i) => i.title)).toEqual(["General", "Install"]);
    expect(items.map((i) => i.url)).toEqual([
      "/w/p1/settings/general",
      "/w/p1/settings/install",
    ]);
  });
});
