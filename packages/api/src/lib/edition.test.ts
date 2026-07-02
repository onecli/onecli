import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  capabilitiesFor,
  CLOUD_ALIAS_KEYS,
  parseEdition,
} from "./edition";

describe("parseEdition", () => {
  it.each<[string | undefined, "oss" | "cloud"]>([
    [undefined, "oss"],
    ["", "oss"],
    ["oss", "oss"],
    ["cloud", "cloud"],
    ["CLOUD", "cloud"],
    ["  cloud  ", "cloud"],
    ["onprem-slim", "oss"], // onprem not recognized yet (Step 1) → oss
    ["totally-unknown", "oss"],
  ])("maps %p → edition %p", (raw, edition) => {
    expect(parseEdition(raw).edition).toBe(edition);
  });

  it("produces no variant in Step 1 (oss/cloud only)", () => {
    for (const raw of [undefined, "", "oss", "cloud", "onprem-slim"]) {
      expect(parseEdition(raw).variant).toBeNull();
    }
  });
});

describe("capabilitiesFor", () => {
  it("returns OSS capabilities for the oss edition", () => {
    expect(capabilitiesFor(parseEdition("oss"))).toEqual({
      auth: "local",
      tenancy: "org-per-user",
      billing: false,
    });
  });

  it("returns cloud capabilities for the cloud edition", () => {
    expect(capabilitiesFor(parseEdition("cloud"))).toEqual({
      auth: "cognito",
      tenancy: "multi-org",
      billing: true,
    });
  });

  it("resolves to the CAPABILITIES table entry", () => {
    expect(capabilitiesFor(parseEdition("oss"))).toBe(CAPABILITIES.oss);
    expect(capabilitiesFor(parseEdition("cloud"))).toBe(CAPABILITIES.cloud);
  });
});

describe("CLOUD_ALIAS_KEYS", () => {
  it("has no duplicate keys", () => {
    expect(new Set(CLOUD_ALIAS_KEYS).size).toBe(CLOUD_ALIAS_KEYS.length);
  });

  it("are all module-path aliases", () => {
    for (const key of CLOUD_ALIAS_KEYS) {
      expect(key.startsWith("@")).toBe(true);
    }
  });

  // Best-effort drift guard: every cloud alias key declared here must actually
  // appear in apps/web/next.config.js, which owns the key→value map. Catches a
  // key added/removed in one place but not the other. Resolves relative to the
  // test runner's cwd (the package dir under `vitest`/turbo); Turbo may cache
  // this package's tests when only next.config.js changes, so run directly to be
  // certain after editing that file.
  it("are all present in apps/web/next.config.js", () => {
    const nextConfigSource = readFileSync(
      path.resolve(process.cwd(), "../../apps/web/next.config.js"),
      "utf8",
    );
    for (const key of CLOUD_ALIAS_KEYS) {
      expect(nextConfigSource).toContain(`"${key}"`);
    }
  });
});
