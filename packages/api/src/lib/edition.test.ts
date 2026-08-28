import { describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  capabilitiesFor,
  type Edition,
  parseEdition,
} from "./edition";

describe("parseEdition", () => {
  it.each<[string | undefined, Edition]>([
    [undefined, "onprem"],
    ["", "onprem"],
    ["onprem", "onprem"],
    ["oss", "onprem"], // legacy value
    ["cloud", "cloud"],
    ["CLOUD", "cloud"],
    ["  cloud  ", "cloud"],
    ["totally-unknown", "onprem"],
  ])("maps %p → edition %p", (raw, edition) => {
    expect(parseEdition(raw).edition).toBe(edition);
  });
});

describe("capabilitiesFor", () => {
  it("returns onprem capabilities for the onprem edition", () => {
    expect(capabilitiesFor(parseEdition("onprem"))).toEqual({
      auth: "local",
      billing: false,
      rbac: false,
    });
  });

  it("returns cloud capabilities for the cloud edition", () => {
    expect(capabilitiesFor(parseEdition("cloud"))).toEqual({
      auth: "cognito",
      billing: true,
      rbac: true,
    });
  });

  it("resolves to the CAPABILITIES table entry", () => {
    expect(capabilitiesFor(parseEdition("onprem"))).toBe(CAPABILITIES.onprem);
    expect(capabilitiesFor(parseEdition("cloud"))).toBe(CAPABILITIES.cloud);
  });

  it("entitlement turns rbac on for onprem and changes nothing else", () => {
    expect(capabilitiesFor(parseEdition("onprem"), { entitled: true })).toEqual(
      {
        auth: "local",
        billing: false,
        rbac: true,
      },
    );
    expect(capabilitiesFor(parseEdition("onprem"), { entitled: false })).toBe(
      CAPABILITIES.onprem,
    );
  });

  it("entitlement is a no-op on cloud (rbac is already on)", () => {
    expect(capabilitiesFor(parseEdition("cloud"), { entitled: true })).toEqual(
      CAPABILITIES.cloud,
    );
  });
});
