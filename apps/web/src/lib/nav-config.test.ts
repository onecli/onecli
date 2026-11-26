import { describe, expect, it } from "vitest";
import { getNavItems, workspaceNavItems } from "./nav-config";

/**
 * The §3.13 truth table for the hosted-only nav entries (Skills, step 9):
 * hidden exactly when the sidebar KNOWS the deployment shows no hosted
 * surface; present by default.
 */

const workspaceTitles = () => workspaceNavItems("p1").map((item) => item.title);

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

  it("keeps org administration out of the top-level org nav", () => {
    const titles = flatTitles({ entitled: true });
    for (const t of ["App Availability", "Shared Connections", "Global Policy"])
      expect(titles).not.toContain(t);
  });
});

describe("Channels sits at the org level", () => {
  const orgItems = (opts?: Parameters<typeof getNavItems>[1]) =>
    getNavItems("org-1", opts).flat();

  it("is an org nav entry at the org-level URL", () => {
    const item = orgItems().find((entry) => entry.title === "Channels");
    expect(item?.url).toBe("/org/org-1/channels");
  });

  it("hides on a runnerless deployment, like Skills", () => {
    const titles = orgItems({ hosted: false }).map((item) => item.title);
    expect(titles).not.toContain("Channels");
    expect(titles).not.toContain("Skills");
  });
});

describe("the workspace rows", () => {
  it("are the workspace's own pages, in order", () => {
    expect(workspaceTitles()).toEqual([
      "Connections",
      "Activity",
      "Workspace Settings",
    ]);
  });
});
