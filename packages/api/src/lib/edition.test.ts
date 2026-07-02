import { describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  capabilitiesFor,
  type Edition,
  parseEdition,
  type Variant,
} from "./edition";

describe("parseEdition", () => {
  it.each<[string | undefined, Edition]>([
    [undefined, "oss"],
    ["", "oss"],
    ["oss", "oss"],
    ["cloud", "cloud"],
    ["CLOUD", "cloud"],
    ["  cloud  ", "cloud"],
    ["onprem", "onprem"],
    ["onprem-slim", "onprem"],
    ["onprem-full", "onprem"],
    ["totally-unknown", "oss"],
  ])("maps %p → edition %p", (raw, edition) => {
    expect(parseEdition(raw).edition).toBe(edition);
  });

  it("has no variant for oss/cloud", () => {
    for (const raw of [undefined, "", "oss", "cloud"]) {
      expect(parseEdition(raw).variant).toBeNull();
    }
  });

  it.each<[string, Variant]>([
    ["onprem-slim", "slim"],
    ["onprem-full", "full"],
    ["onprem", null],
    ["onprem-bogus", null],
  ])("parses the variant of %p as %p", (raw, variant) => {
    expect(parseEdition(raw).variant).toBe(variant);
  });
});

describe("capabilitiesFor", () => {
  it("returns OSS capabilities for the oss edition", () => {
    expect(capabilitiesFor(parseEdition("oss"))).toEqual({
      auth: "local",
      tenancy: "org-per-user",
      billing: false,
      orgScopedUI: false,
      webSurface: "full",
      rbac: false,
    });
  });

  it("returns cloud capabilities for the cloud edition", () => {
    expect(capabilitiesFor(parseEdition("cloud"))).toEqual({
      auth: "cognito",
      tenancy: "multi-org",
      billing: true,
      orgScopedUI: true,
      webSurface: "full",
      rbac: true,
    });
  });

  it("returns onprem-slim capabilities (flat web surface)", () => {
    expect(capabilitiesFor(parseEdition("onprem-slim"))).toEqual({
      auth: "local",
      tenancy: "single-org-shared",
      billing: false,
      orgScopedUI: false,
      webSurface: "connect-only",
      rbac: false,
    });
  });

  it("onprem-full extends the onprem base with the org-scoped web surface", () => {
    expect(capabilitiesFor(parseEdition("onprem-full"))).toEqual({
      auth: "local",
      tenancy: "single-org-shared",
      billing: false,
      orgScopedUI: true,
      webSurface: "full",
      rbac: false,
    });
  });

  it("onprem-slim and onprem-full differ in orgScopedUI + webSurface", () => {
    const slim = capabilitiesFor(parseEdition("onprem-slim"));
    const full = capabilitiesFor(parseEdition("onprem-full"));
    expect(full).toEqual({ ...slim, orgScopedUI: true, webSurface: "full" });
    expect(slim.orgScopedUI).toBe(false);
    expect(full.orgScopedUI).toBe(true);
    expect(slim.webSurface).toBe("connect-only");
    expect(full.webSurface).toBe("full");
  });

  it("resolves to the CAPABILITIES table entry for base editions", () => {
    expect(capabilitiesFor(parseEdition("oss"))).toBe(CAPABILITIES.oss);
    expect(capabilitiesFor(parseEdition("cloud"))).toBe(CAPABILITIES.cloud);
    expect(capabilitiesFor(parseEdition("onprem"))).toBe(CAPABILITIES.onprem);
    // onprem-full derives a distinct object via the variant override.
    expect(capabilitiesFor(parseEdition("onprem-full"))).not.toBe(
      CAPABILITIES.onprem,
    );
  });
});
