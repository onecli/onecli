import { afterEach, describe, expect, it, vi } from "vitest";

// The build-time env bake in next.config.js: full URLs pass through first
// (what cloud CI sends), the bare-domain vars remain a deprecated fallback,
// and a var-less build (the published self-host images) bakes the localhost
// last resorts. Nothing pinned this before — the only proof the cloud bundle
// baked the right origins was a deployed image.
//
// Web has no hermetic-env setup, so every case deletes the ambient inputs
// itself and re-imports the config fresh.

const INPUTS = [
  "NEXT_PUBLIC_API_URL",
  "NEXT_PUBLIC_GATEWAY_API_URL",
  "API_DOMAIN",
  "GATEWAY_API_DOMAIN",
  "NEXT_PUBLIC_EDITION",
  "APP_VERSION",
] as const;

const orig: Record<string, string | undefined> = {};
for (const key of INPUTS) orig[key] = process.env[key];

const loadBake = async (
  env: Partial<Record<(typeof INPUTS)[number], string>>,
) => {
  vi.resetModules();
  for (const key of INPUTS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const config = (await import("../next.config.js")).default;
  return config.env as Record<string, string>;
};

afterEach(() => {
  for (const key of INPUTS) {
    if (orig[key] === undefined) delete process.env[key];
    else process.env[key] = orig[key];
  }
});

describe("next.config.js env bake", () => {
  // No localhost bake, deliberately: env{} keys inline into the SERVER
  // bundle too, where a baked localhost would read as a configured override
  // and beat the resolver's runtime derivation (proven live: a prebuilt
  // image advertised localhost:10256 regardless of ONECLI_EXTERNAL_URL).
  it("bakes NOTHING when no value was provided (published self-host images)", async () => {
    const env = await loadBake({});
    expect(env).not.toHaveProperty("NEXT_PUBLIC_API_URL");
    expect(env).not.toHaveProperty("NEXT_PUBLIC_GATEWAY_API_URL");
    expect(env.NEXT_PUBLIC_EDITION).toBe("onprem");
  });

  it("passes full URLs through verbatim (the cloud CI path)", async () => {
    const env = await loadBake({
      NEXT_PUBLIC_API_URL: "https://api.onecli.sh",
      NEXT_PUBLIC_GATEWAY_API_URL: "https://api.onecli.sh",
      NEXT_PUBLIC_EDITION: "cloud",
    });
    expect(env.NEXT_PUBLIC_API_URL).toBe("https://api.onecli.sh");
    expect(env.NEXT_PUBLIC_GATEWAY_API_URL).toBe("https://api.onecli.sh");
  });

  it("keeps the deprecated bare-domain fallback with its cloud https heuristic", async () => {
    const env = await loadBake({
      API_DOMAIN: "api.onecli.sh",
      GATEWAY_API_DOMAIN: "api.onecli.sh",
      NEXT_PUBLIC_EDITION: "cloud",
    });
    // NODE_ENV is not "development" under vitest run, so cloud means https.
    expect(env.NEXT_PUBLIC_API_URL).toBe("https://api.onecli.sh");
    expect(env.NEXT_PUBLIC_GATEWAY_API_URL).toBe("https://api.onecli.sh");
  });

  it("full URL beats the deprecated domain var", async () => {
    const env = await loadBake({
      NEXT_PUBLIC_API_URL: "https://full.example",
      API_DOMAIN: "domain.example",
      NEXT_PUBLIC_EDITION: "cloud",
    });
    expect(env.NEXT_PUBLIC_API_URL).toBe("https://full.example");
  });
});

describe("next.config.js rewrites guard", () => {
  const loadConfig = async (
    env: Partial<Record<(typeof INPUTS)[number], string>>,
    nodeEnv?: string,
  ) => {
    vi.resetModules();
    if (nodeEnv) vi.stubEnv("NODE_ENV", nodeEnv);
    for (const key of INPUTS) delete process.env[key];
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    return (await import("../next.config.js")).default;
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The single-origin dev proxy is edition-agnostic on purpose — cloud dev
  // behind one tunnel needs it exactly like onprem dev — while production of
  // BOTH editions must never bake it. The guard is solely `!isDev`, so pin
  // both arms: restoring the old `isCloud ||` term (plausible in an OSS
  // merge-back) or dropping the guard must fail here first.
  it("bakes no rewrites outside development, either edition", async () => {
    // NODE_ENV under vitest is not "development", so this is the build arm.
    expect((await loadConfig({})).rewrites).toBeUndefined();
    expect(
      (await loadConfig({ NEXT_PUBLIC_EDITION: "cloud" })).rewrites,
    ).toBeUndefined();
  });

  it("defines the dev proxy in development regardless of edition", async () => {
    expect((await loadConfig({}, "development")).rewrites).toBeTypeOf(
      "function",
    );
    expect(
      (await loadConfig({ NEXT_PUBLIC_EDITION: "cloud" }, "development"))
        .rewrites,
    ).toBeTypeOf("function");
  });
});
