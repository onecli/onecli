import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The validator + env/file resolver don't touch the DB; stub it so importing the
// module doesn't pull in a real Prisma client.
vi.mock("@onecli/db", () => ({ db: {} }));

import {
  isValidOrgApiKey,
  resolveConfiguredOrgApiKey,
} from "./api-key-service";

describe("isValidOrgApiKey", () => {
  it("accepts oc_org_ + 64 lowercase hex", () => {
    expect(isValidOrgApiKey("oc_org_" + "a".repeat(64))).toBe(true);
    expect(isValidOrgApiKey("oc_org_" + "0123456789abcdef".repeat(4))).toBe(
      true,
    );
  });

  it("rejects the wrong prefix, length, or charset", () => {
    expect(isValidOrgApiKey("oc_" + "a".repeat(64))).toBe(false); // project prefix
    expect(isValidOrgApiKey("oc_org_" + "a".repeat(63))).toBe(false); // too short
    expect(isValidOrgApiKey("oc_org_" + "a".repeat(65))).toBe(false); // too long
    expect(isValidOrgApiKey("oc_org_" + "A".repeat(64))).toBe(false); // uppercase
    expect(isValidOrgApiKey("oc_org_" + "g".repeat(64))).toBe(false); // non-hex
    expect(isValidOrgApiKey("")).toBe(false);
    expect(isValidOrgApiKey("oc_org_")).toBe(false);
  });
});

describe("resolveConfiguredOrgApiKey", () => {
  const orig = { ...process.env };
  afterEach(() => {
    process.env = { ...orig };
  });

  it("returns undefined when neither env nor file is set", () => {
    delete process.env.ONECLI_ORG_API_KEY;
    delete process.env.ONECLI_ORG_API_KEY_FILE;
    expect(resolveConfiguredOrgApiKey()).toBeUndefined();
  });

  it("prefers ONECLI_ORG_API_KEY (trimmed)", () => {
    process.env.ONECLI_ORG_API_KEY = "  oc_org_env  ";
    expect(resolveConfiguredOrgApiKey()).toBe("oc_org_env");
  });

  it("falls back to ONECLI_ORG_API_KEY_FILE (trimmed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "onecli-orgkey-"));
    const file = join(dir, "key");
    writeFileSync(file, "oc_org_fromfile\n");
    delete process.env.ONECLI_ORG_API_KEY;
    process.env.ONECLI_ORG_API_KEY_FILE = file;
    try {
      expect(resolveConfiguredOrgApiKey()).toBe("oc_org_fromfile");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers the env var over the file when both are set", () => {
    const dir = mkdtempSync(join(tmpdir(), "onecli-orgkey-"));
    const file = join(dir, "key");
    writeFileSync(file, "oc_org_fromfile");
    process.env.ONECLI_ORG_API_KEY = "oc_org_fromenv";
    process.env.ONECLI_ORG_API_KEY_FILE = file;
    try {
      expect(resolveConfiguredOrgApiKey()).toBe("oc_org_fromenv");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws a clear error when ONECLI_ORG_API_KEY_FILE is unreadable", () => {
    delete process.env.ONECLI_ORG_API_KEY;
    process.env.ONECLI_ORG_API_KEY_FILE = join(
      tmpdir(),
      "onecli-does-not-exist-xxxxxxxx",
    );
    expect(() => resolveConfiguredOrgApiKey()).toThrow(
      /ONECLI_ORG_API_KEY_FILE could not be read/,
    );
  });
});
