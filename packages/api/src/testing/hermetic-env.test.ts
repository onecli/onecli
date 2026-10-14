import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getApps } from "../apps/registry";
import {
  AMBIENT_HAZARD_VARS,
  HERMETIC_BASELINE_KEY,
  HERMETIC_CA_PEM_SENTINEL,
  HERMETIC_MARKER_VAR,
  PRESERVED_AMBIENT_VARS,
  applyHermeticEnv,
  normalizeTestEnv,
  workerBaselineHolder,
  type HermeticBaselineHolder,
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
      "SENTRY_CLIENT_ID",
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

describe("applyHermeticEnv: one worker, many files", () => {
  it("the first file normalizes and records the worker baseline", () => {
    const holder: HermeticBaselineHolder = {};
    const env: NodeJS.ProcessEnv = {
      EDITION: "cloud",
      DATABASE_URL: "postgresql://ambient",
      PATH: "/usr/bin",
      VITEST_WORKER_ID: "1",
    };
    applyHermeticEnv(env, holder);
    expect(env.NEXT_PUBLIC_EDITION).toBe("cloud");
    expect(env.DATABASE_URL).toBeUndefined();
    expect(holder[HERMETIC_BASELINE_KEY]).toMatchObject({
      NEXT_PUBLIC_EDITION: "cloud",
      PATH: "/usr/bin",
      NODE_ENV: "test",
    });
    // The runner's own bookkeeping is vitest's, never part of our baseline.
    expect(holder[HERMETIC_BASELINE_KEY]).not.toHaveProperty(
      "VITEST_WORKER_ID",
    );
  });

  it("a later file starts from the baseline, not from the previous file's pins", () => {
    // The incident: the onprem lane (edition unset), one file pins cloud
    // and never undoes it, and the NEXT file loaded as cloud.
    const holder: HermeticBaselineHolder = {};
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    applyHermeticEnv(env, holder);

    env.NEXT_PUBLIC_EDITION = "cloud";
    env.EDITION = "cloud";
    env.DATABASE_URL = "postgresql://previous-file";
    env.TURN_CEILING_SECONDS = "1800";
    env.PATH = "/changed";
    delete env.NODE_ENV;

    applyHermeticEnv(env, holder);
    expect(env.NEXT_PUBLIC_EDITION).toBeUndefined();
    expect(env.EDITION).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.TURN_CEILING_SECONDS).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.NODE_ENV).toBe("test");
    expect(env).toEqual({ ...holder[HERMETIC_BASELINE_KEY] });
  });

  it("the cloud lane's carrier survives every reset, even after an onprem pin", () => {
    const holder: HermeticBaselineHolder = {};
    const env: NodeJS.ProcessEnv = { NEXT_PUBLIC_EDITION: "cloud" };
    applyHermeticEnv(env, holder);
    env.NEXT_PUBLIC_EDITION = "onprem";
    env.EDITION = "onprem";
    applyHermeticEnv(env, holder);
    expect(env.NEXT_PUBLIC_EDITION).toBe("cloud");
    expect(env.EDITION).toBeUndefined();
  });

  it("leaves the runner's per-worker vars to vitest", () => {
    const holder: HermeticBaselineHolder = {};
    const env: NodeJS.ProcessEnv = { VITEST: "true", TEST: "true" };
    applyHermeticEnv(env, holder);
    env.VITEST_POOL_ID = "2";
    applyHermeticEnv(env, holder);
    expect(env).toMatchObject({
      VITEST: "true",
      TEST: "true",
      VITEST_POOL_ID: "2",
    });
  });
});

describe("setup wiring", () => {
  it("recorded this worker's baseline on globalThis", () => {
    // The reset only works if the setup keeps the baseline where the next
    // file's setup can find it: the worker's globalThis.
    const baseline = workerBaselineHolder()[HERMETIC_BASELINE_KEY];
    expect(baseline).toBeDefined();
    expect(baseline?.[HERMETIC_MARKER_VAR]).toBe("1");
    expect(baseline?.GATEWAY_CA_PEM_FILE).toBe(HERMETIC_CA_PEM_SENTINEL);
  });

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
