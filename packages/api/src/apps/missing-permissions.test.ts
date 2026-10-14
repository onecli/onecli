import { describe, expect, it } from "vitest";
import {
  describeScopes,
  lacksScope,
  missingPermissions,
  setPartialGrantParams,
} from "./missing-permissions";

const G = "https://www.googleapis.com/auth/";
const IDENTITY = ["openid", `${G}userinfo.email`, `${G}userinfo.profile`];
const names = (provider: string, scopes: string[]) =>
  missingPermissions(provider, scopes).map((p) => p.name);
const scopesOf = (provider: string, scopes: string[]) =>
  missingPermissions(provider, scopes).map((p) => p.scope);

describe("missingPermissions", () => {
  it("flags Drive's read permission when only drive.file was granted", () => {
    expect(names("google-drive", [...IDENTITY, `${G}drive.file`])).toEqual([
      "Read files",
    ]);
  });

  it("is empty for a full Drive grant", () => {
    expect(
      names("google-drive", [
        ...IDENTITY,
        `${G}drive.file`,
        `${G}drive.readonly`,
      ]),
    ).toEqual([]);
  });

  it("never flags identity scopes", () => {
    expect(
      missingPermissions("google-drive", [
        `${G}drive.file`,
        `${G}drive.readonly`,
      ]),
    ).toEqual([]);
  });

  it("treats an empty grant list as unknown, not as everything missing", () => {
    expect(missingPermissions("google-drive", [])).toEqual([]);
    expect(missingPermissions("google-drive", null)).toEqual([]);
  });

  it("lets a Google scope cover its own .readonly", () => {
    expect(names("google-sheets", [...IDENTITY, `${G}spreadsheets`])).toEqual(
      [],
    );
  });

  it("lets a legacy broad Google grant cover the narrower scopes now requested", () => {
    // Connections made while Calendar and Drive still requested the full scope.
    expect(names("google-calendar", [...IDENTITY, `${G}calendar`])).toEqual([]);
    expect(names("google-drive", [...IDENTITY, `${G}drive`])).toEqual([]);
  });

  it("never lets a Google prefix cover a separate sibling permission", () => {
    // Google lists these as distinct scopes: `contacts` can't read Other
    // contacts, and `youtube` can't post comments (`youtube.force-ssl`).
    expect(
      scopesOf("google-contacts", [
        ...IDENTITY,
        `${G}contacts`,
        `${G}directory.readonly`,
      ]),
    ).toEqual([`${G}contacts.other.readonly`]);
    expect(scopesOf("youtube", [...IDENTITY, `${G}youtube`])).toEqual([
      `${G}youtube.force-ssl`,
    ]);
  });

  it("lets Microsoft ReadWrite cover Read, case-insensitively", () => {
    expect(
      names("microsoft-onenote", [
        "openid",
        "profile",
        "email",
        "offline_access",
        "user.read",
        "notes.readwrite",
        "Notes.Create",
      ]),
    ).toEqual([]);
  });

  it("splits a comma-joined grant stored as one entry", () => {
    expect(
      missingPermissions("google-drive", [`${G}drive.file,${G}drive.readonly`]),
    ).toEqual([]);
  });

  it("lists a scope an app describes twice only once", () => {
    // HubSpot describes `tickets` for both read and write.
    expect(
      scopesOf("hubspot", ["oauth", "crm.objects.contacts.read"]).filter(
        (s) => s === "tickets",
      ),
    ).toEqual(["tickets"]);
  });

  it("returns nothing for unknown and non-OAuth providers", () => {
    expect(missingPermissions("no-such-app", ["x"])).toEqual([]);
    expect(missingPermissions("stripe", ["x"])).toEqual([]);
  });

  it("returns only public, app-defined fields", () => {
    const [first] = missingPermissions("google-drive", [`${G}drive.file`]);
    expect(Object.keys(first ?? {}).sort()).toEqual(
      ["description", "name", "scope"].sort(),
    );
  });
});

describe("describeScopes", () => {
  it("resolves only scopes the app requests and describes", () => {
    expect(
      describeScopes("google-drive", (s) =>
        [`${G}drive.readonly`, "openid", "https://evil.example/scope"].includes(
          s,
        ),
      ).map((p) => p.name),
    ).toEqual(["Read files"]);
  });
});

describe("lacksScope", () => {
  it("answers for one specific scope", () => {
    expect(
      lacksScope("google-drive", [`${G}drive.file`], `${G}drive.readonly`),
    ).toBe(true);
    expect(
      lacksScope("google-drive", [`${G}drive.readonly`], `${G}drive.readonly`),
    ).toBe(false);
  });
});

describe("setPartialGrantParams", () => {
  const params = (
    granted: string[],
    scope: { workspaceId: string } | { orgId: string },
  ) => {
    const p = new URLSearchParams({ status: "success" });
    setPartialGrantParams(p, "google-drive", granted, {
      connectionId: "conn-1",
      scope,
    });
    return Object.fromEntries(p);
  };

  it("names the missing scopes and the connection a retry re-authenticates", () => {
    expect(params([`${G}drive.file`], { workspaceId: "ws-1" })).toEqual({
      status: "success",
      missing: `${G}drive.readonly`,
      connectionId: "conn-1",
      workspaceId: "ws-1",
    });
  });

  it("carries an org connection's org, not a workspace", () => {
    expect(params([`${G}drive.file`], { orgId: "org-1" })).toEqual({
      status: "success",
      missing: `${G}drive.readonly`,
      connectionId: "conn-1",
      orgId: "org-1",
    });
  });

  it("adds nothing for a full grant", () => {
    expect(
      params([`${G}drive.file`, `${G}drive.readonly`], { workspaceId: "ws-1" }),
    ).toEqual({ status: "success" });
  });
});
