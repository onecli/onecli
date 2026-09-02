import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getApps } from "../apps/registry";
import {
  AMBIENT_HAZARD_VARS,
  HERMETIC_CA_PEM_SENTINEL,
  HERMETIC_MARKER_VAR,
  PRESERVED_AMBIENT_VARS,
  normalizeTestEnv,
} from "./hermetic-env";

describe("normalizeTestEnv", () => {
  it("folds EDITION into NEXT_PUBLIC_EDITION and deletes it — EDITION wins, like production", () => {
    const env: NodeJS.ProcessEnv = {
      EDITION: "cloud",
      NEXT_PUBLIC_EDITION: "onprem",
    };
    normalizeTestEnv(env);
    expect(env.EDITION).toBeUndefined();
    expect(env.NEXT_PUBLIC_EDITION).toBe("cloud");
  });

  it("folds an empty-string EDITION too — production's ?? would keep it, parsing as onprem", () => {
    const env: NodeJS.ProcessEnv = {
      EDITION: "",
      NEXT_PUBLIC_EDITION: "cloud",
    };
    normalizeTestEnv(env);
    expect(env.EDITION).toBeUndefined();
    expect(env.NEXT_PUBLIC_EDITION).toBe("");
  });

  it("leaves NEXT_PUBLIC_EDITION alone when EDITION is unset — it is CI's lane carrier", () => {
    const env: NodeJS.ProcessEnv = { NEXT_PUBLIC_EDITION: "cloud" };
    normalizeTestEnv(env);
    expect(env.NEXT_PUBLIC_EDITION).toBe("cloud");
  });

  it("deletes the load-bearing ambient hazards", () => {
    // A hand-picked subset asserted explicitly, so trimming the exported
    // list cannot silently shrink this test with it.
    const loadBearing = [
      "OAUTH_STATE_SECRET",
      "KMS_KEY_ARN",
      "DATABASE_URL",
      "REDIS_HOST",
      "ENTERPRISE_ENABLED",
      "STRIPE_TEAM_BASE_PRICE_ID",
      "SLACK_CLIENT_ID",
      "MICROSOFT_CLIENT_ID",
      "RESEND_API_KEY",
      "DEV_TRUST_ANY_AUTH_ORIGIN",
      "BETTER_AUTH_SECRET",
    ];
    const env: NodeJS.ProcessEnv = {};
    for (const name of loadBearing) env[name] = "leaked";
    for (const name of AMBIENT_HAZARD_VARS) env[name] = "leaked";

    normalizeTestEnv(env);

    for (const name of loadBearing) expect(env[name]).toBeUndefined();
    for (const name of AMBIENT_HAZARD_VARS)
      expect(env[name], name).toBeUndefined();
  });

  it("pins NODE_ENV to test and the CA pem file to the nonexistent sentinel", () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      GATEWAY_CA_PEM_FILE: "/home/dev/.onecli/gateway/ca.pem",
    };
    normalizeTestEnv(env);
    expect(env.NODE_ENV).toBe("test");
    expect(env.GATEWAY_CA_PEM_FILE).toBe(HERMETIC_CA_PEM_SENTINEL);
  });

  it("preserves the deliberate pass-throughs", () => {
    const env: NodeJS.ProcessEnv = {
      CI: "true",
      POLICY_PROOF_DATABASE_URL: "postgresql://ci:ci@localhost:5440/onecli",
      LOG_LEVEL: "debug",
      HOME: "/home/dev",
      PATH: "/usr/bin",
    };
    normalizeTestEnv(env);
    expect(env.CI).toBe("true");
    expect(env.POLICY_PROOF_DATABASE_URL).toBe(
      "postgresql://ci:ci@localhost:5440/onecli",
    );
    expect(env.LOG_LEVEL).toBe("debug");
    expect(env.HOME).toBe("/home/dev");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("covers every app-registry credential env var — a new integration must join the list", () => {
    // Same self-checking shape as licensing/enterprise-lock.test.ts: walk
    // the registry so a future app's envDefaults cannot silently reopen
    // the ambient-credential leak.
    const registryNames = getApps().flatMap((app) =>
      Object.values(app.configurable?.envDefaults ?? {}),
    );
    expect(registryNames.length).toBeGreaterThan(0);
    for (const name of registryNames) {
      expect(AMBIENT_HAZARD_VARS, name).toContain(name);
    }
  });

  it("classifies every production env read — a new process.env.X must be placed", () => {
    // The drift guard for the hand-maintained list: scan every literal
    // `process.env.X` read in packages/api and packages/db production
    // source and require each name to be either a deleted hazard or a
    // deliberately preserved pass-through. Adding an env read without
    // classifying it fails here — the exact drift that let ambient
    // EDITION defeat 45 suites goes loud instead of silent.
    const packageSrc = join(import.meta.dirname, "..");
    const dbSrc = join(import.meta.dirname, "../../../db/src");
    const sources = [packageSrc, dbSrc].flatMap((root) =>
      readdirSync(root, { withFileTypes: true, recursive: true })
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith(".ts") &&
            !entry.name.endsWith(".test.ts") &&
            !entry.parentPath.includes("/testing"),
        )
        .map((entry) => join(entry.parentPath, entry.name)),
    );
    expect(sources.length).toBeGreaterThan(100);

    const discovered = new Set<string>();
    for (const file of sources) {
      for (const match of readFileSync(file, "utf8").matchAll(
        /process\.env\.([A-Z][A-Z0-9_]*)/g,
      )) {
        const name = match[1];
        if (name) discovered.add(name);
      }
    }
    expect(discovered.size).toBeGreaterThan(50);

    const classified = new Set([
      ...AMBIENT_HAZARD_VARS,
      ...PRESERVED_AMBIENT_VARS,
    ]);
    for (const name of discovered) {
      expect(classified, `unclassified env read: ${name}`).toContain(name);
    }
    // The two classes must stay disjoint, or a name could be both deleted
    // and relied upon.
    for (const name of PRESERVED_AMBIENT_VARS) {
      expect(AMBIENT_HAZARD_VARS, name).not.toContain(name);
    }
  });
});

describe("setup wiring", () => {
  it("ran the hermetic setup before this file loaded", () => {
    // Fails on every machine if vitest.config.ts stops mounting the setup
    // file — the marker only exists when normalizeTestEnv ran in this worker.
    expect(process.env.ONECLI_TEST_HERMETIC).toBe("1");
    expect(process.env[HERMETIC_MARKER_VAR]).toBe("1");
    // The marker alone is spoofable (a shell could export it); the sentinel
    // path is not — no real environment carries this exact value, so it
    // proves normalizeTestEnv itself ran, not just that the var exists.
    expect(process.env.GATEWAY_CA_PEM_FILE).toBe(HERMETIC_CA_PEM_SENTINEL);
    // And the fold actually applied to this process: a set EDITION can only
    // be a test's own doing, never the ambient shell's.
    expect(process.env.EDITION).toBeUndefined();
  });
});
