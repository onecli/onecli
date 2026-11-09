import { describe, expect, it } from "vitest";
import {
  PAGE_LOCAL_PARAMS,
  SETTINGS_PAGES,
  carrySettingsParam,
  connectionsModalHref,
  isSettingsPageId,
  visibleSettingsPages,
  withSettingsParam,
  type SettingsViewer,
} from "./pages";

/**
 * The Settings modal's map (plans/flatten-ui.md): who sees which
 * page, and how `?settings=` is written. The nav and the slot page share
 * `visibleSettingsPages`, so these are the rules a deep link cannot get
 * around either.
 */

const everyone: SettingsViewer = {
  hasWorkspace: true,
  canManageWorkspace: true,
  isAdmin: true,
  billing: true,
  hosted: true,
};
const ids = (viewer: SettingsViewer) =>
  visibleSettingsPages(viewer).map((p) => p.id);

describe("visibleSettingsPages", () => {
  it("shows an admin with a workspace every page", () => {
    expect(ids(everyone)).toEqual(SETTINGS_PAGES.map((p) => p.id));
  });

  it("hides the Organization section and workspace management from a member", () => {
    const member = ids({
      ...everyone,
      isAdmin: false,
      canManageWorkspace: false,
    });
    expect(member).toEqual(["apps", "activity", "profile", "api-keys"]);
  });

  it("hides workspace pages on an org URL", () => {
    const orgUrl = ids({
      ...everyone,
      hasWorkspace: false,
      canManageWorkspace: false,
    });
    expect(orgUrl).not.toContain("apps");
    expect(orgUrl).not.toContain("activity");
    expect(orgUrl).not.toContain("workspace");
    // Members is org administration (the old /team), reachable from an org URL.
    expect(orgUrl).toContain("members");
  });

  it("files Members under Organization: the list is org membership", () => {
    // The roster, roles, invites and suspensions are `OrganizationMember`
    // rows. Who may use one workspace is the Workspace access card under
    // Workspace > Settings. So Members sits with the org pages whether or
    // not the URL names a workspace, first in its section.
    for (const viewer of [everyone, { ...everyone, hasWorkspace: false }]) {
      const pages = visibleSettingsPages(viewer);
      const members = pages.find((p) => p.id === "members");
      expect(members?.section).toBe("Organization");
      expect(pages.filter((p) => p.section === "Organization")[0]?.id).toBe(
        "members",
      );
    }
    expect(
      SETTINGS_PAGES.filter((p) => p.section === "Workspace").map((p) => p.id),
    ).toEqual(["apps", "activity", "workspace"]);
  });

  it("hides Billing without the billing capability and Slack without hosted agents", () => {
    const selfHost = ids({ ...everyone, billing: false, hosted: false });
    expect(selfHost).not.toContain("billing");
    expect(selfHost).not.toContain("slack");
    expect(selfHost).toContain("general");
  });
});

describe("withSettingsParam", () => {
  it("opens a page over the current URL and keeps the page's own params", () => {
    expect(
      withSettingsParam("/w/ws/agents/ag/chat", "draft=hi", "members"),
    ).toBe("/w/ws/agents/ag/chat?draft=hi&settings=members");
  });

  it("closing removes only the modal's params", () => {
    expect(
      withSettingsParam("/w/ws/agents/ag/chat", "settings=apps&draft=hi", null),
    ).toBe("/w/ws/agents/ag/chat?draft=hi");
    expect(
      withSettingsParam("/w/ws/agents/ag/chat", "settings=apps", null),
    ).toBe("/w/ws/agents/ag/chat");
  });

  it("drops a page's local params when moving to another page", () => {
    const search = `settings=activity&${PAGE_LOCAL_PARAMS.map((k) => `${k}=x`).join("&")}`;
    expect(withSettingsParam("/w/ws", search, "apps")).toBe(
      "/w/ws?settings=apps",
    );
  });
});

describe("connectionsModalHref", () => {
  const chat = "/w/ws/agents/ag/chat";

  it("turns an app's route into the page's app param", () => {
    expect(
      connectionsModalHref(chat, "settings=apps", "apps", "/apps/gmail"),
    ).toBe(`${chat}?settings=apps&app=gmail`);
    expect(
      connectionsModalHref(
        chat,
        "settings=shared-apps",
        "shared-apps",
        "/apps/gmail",
      ),
    ).toBe(`${chat}?settings=shared-apps&app=gmail`);
  });

  it("turns a vault's route into the vault param, and a tab into tab", () => {
    expect(connectionsModalHref(chat, "", "apps", "/vaults/bitwarden")).toBe(
      `${chat}?vault=bitwarden&settings=apps`,
    );
    expect(connectionsModalHref(chat, "", "apps", "/vaults")).toBe(
      `${chat}?tab=vaults&settings=apps`,
    );
    expect(connectionsModalHref(chat, "", "apps", "/llms")).toBe(
      `${chat}?tab=llms&settings=apps`,
    );
  });

  it("the catalog itself is the page with no local params", () => {
    expect(connectionsModalHref(chat, "settings=apps&app=gmail", "apps")).toBe(
      `${chat}?settings=apps`,
    );
  });

  it("carries the sub-page's own query and drops the old page-local ones", () => {
    expect(
      connectionsModalHref(
        chat,
        "settings=apps&q=gm&category=email&draft=hi",
        "apps",
        "/apps/gmail?connected=c1",
      ),
    ).toBe(`${chat}?settings=apps&draft=hi&app=gmail&connected=c1`);
  });

  it("re-encodes a crafted provider instead of steering the path", () => {
    expect(connectionsModalHref(chat, "", "apps", "/apps/..%2F..%2Fetc")).toBe(
      `${chat}?app=..%252F..%252Fetc&settings=apps`,
    );
  });
});

describe("isSettingsPageId", () => {
  it("accepts every registry id and nothing else", () => {
    for (const p of SETTINGS_PAGES) expect(isSettingsPageId(p.id)).toBe(true);
    expect(isSettingsPageId("team")).toBe(false);
    expect(isSettingsPageId(undefined)).toBe(false);
    expect(isSettingsPageId(["members"])).toBe(false);
  });
});

describe("carrySettingsParam", () => {
  it("keeps an open modal through a landing redirect", () => {
    expect(
      carrySettingsParam("/w/ws/agents/ag/chat", { settings: "members" }),
    ).toBe("/w/ws/agents/ag/chat?settings=members");
  });

  it("takes the first of a repeated param", () => {
    expect(
      carrySettingsParam("/w/ws/agents/ag/chat", {
        settings: ["billing", "members"],
      }),
    ).toBe("/w/ws/agents/ag/chat?settings=billing");
  });

  it("carries nothing else, and nothing that is not a page", () => {
    expect(carrySettingsParam("/w/ws/agents/ag/chat", {})).toBe(
      "/w/ws/agents/ag/chat",
    );
    expect(
      carrySettingsParam("/w/ws/agents/ag/chat", {
        settings: "team",
        tab: "llms",
      }),
    ).toBe("/w/ws/agents/ag/chat");
    expect(
      carrySettingsParam("/w/ws/agents/ag/chat", {
        settings: "members",
        tab: "llms",
      }),
    ).toBe("/w/ws/agents/ag/chat?settings=members");
  });
});
