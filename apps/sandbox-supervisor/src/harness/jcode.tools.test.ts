import { describe, expect, it } from "vitest";
import {
  JCODE_DISABLED_TOOLS_VALUE,
  JCODE_EFFORT,
  JCODE_SWARM_ENV,
  JCODE_WEBSEARCH_ENV,
  managedConfigToml,
  managedConfigTomlWithProvider,
  SWARM_LIGHT_PROMPT,
  SWARM_WORKER_CAP,
  toJcodeModel,
  WEBSEARCH_NATIVE_MAX_USES,
} from "./jcode";

/**
 * The harness-native tool kill-switches, pinned. These two values are what
 * keeps a hosted agent gateway-first: the env list removes the runtime's own
 * integration tooling from the model's tool list, and the config opt-out
 * stops the sponsor catalog from registering at all. Both were live-observed
 * steering an agent into vendor login flows and third-party product
 * recommendations before it found the gateway.
 */

describe("the disabled harness-native tools", () => {
  it("disables the gateway competitors alongside the platform duplicates", () => {
    // MUTATION-PROOF: drop any entry and this fails. The exact-string pin is
    // deliberate — this constant IS the launch env value, and upstream
    // matches names exactly (aliases resolved on its side). `memory` is the
    // write-back amendment's lockdown: [features] memory=false alone leaves
    // the native tool callable (v0.71.1, still true in v0.78.1), and platform
    // memory must be the ONLY memory. `maintainer_feedback`/`jcode_docs` are
    // the v0.78.1 bump's vendor-identity kills (rationale in the adapter
    // header). ⛔ The literal name `mcp` must NEVER appear here — upstream
    // treats it as a meta-entry disabling every mcp__* tool, which would
    // kill the platform-tools bridge. `browser` is the 2026-09-09 trap
    // removal: the native tool is a Firefox-extension bridge that can never
    // work in a headless guest, and its self-description sent the model into
    // setup loops (observed live); chromium is baked into the image instead.
    // `applet`/`panel`/`side_panel` draw into the vendor's desktop app, which
    // no platform surface shows, yet report success, so the model pointed
    // people at a card that was never shown (observed live).
    // `calendar`/`compile_remote` answer with the vendor's own logins.
    expect(JCODE_DISABLED_TOOLS_VALUE).toBe(
      "schedule,skill_manage,gmail,integration_tools,memory,maintainer_feedback,jcode_docs,browser,applet,panel,side_panel,calendar,compile_remote",
    );
  });
});

describe("the managed config's tool-surface pin", () => {
  it("pins mcp_tools=eager — the config half of the platform-tool cliff fence", () => {
    // Upstream defaults mcp_tools="auto" (v0.79.1+): above a token
    // threshold every mcp__* definition is silently replaced by a generic
    // search/call pair — which would strip the platform tools out of the
    // model's tool list. The env half (JCODE_MCP_TOOLS) is asserted by the
    // launch wiring; this pins the config statement.
    expect(managedConfigToml).toMatch(/\[tools\]\nmcp_tools = "eager"/);
  });
});

describe("the managed config's update opt-out", () => {
  it("pins check_updates=false — the config half of the version pin", () => {
    // MUTATION-PROOF: drop the key and this fails. The key defaults TRUE
    // upstream (v0.76+) and gates the startup update-check thread; the env
    // half (JCODE_NO_AUTO_UPDATE) is asserted by the launch wiring, this
    // pins the config half.
    expect(managedConfigToml).toMatch(/check_updates = false/);
  });
});

describe("the managed config's context cap", () => {
  it("caps the compaction budget at 200k tokens", () => {
    // MUTATION-PROOF: drop the section or the key and this fails. Without it
    // a 1M-window model compacts at 80% of its window (~800k), so a long
    // conversation re-sends that much on every request.
    expect(managedConfigToml).toMatch(
      /\[compaction\]\nmax_context_tokens = 200000\n/,
    );
  });

  it("pins the one-hour Anthropic prompt cache under [provider]", () => {
    // Upstream's default today; pinned so a default flip cannot quietly
    // drop the cache to 5 minutes. MUTATION-PROOF: remove the key, or move
    // it out of [provider], and this fails. Order within the section is free.
    expect(managedConfigToml).toMatch(
      /\[provider\]\n(?:[^[\n][^\n]*\n)*anthropic_cache_ttl_1h = true\n/,
    );
  });
});

describe("the managed config's sponsor opt-out", () => {
  it("opts out of integration discovery", () => {
    expect(managedConfigToml).toMatch(/\[sponsors\]\nenabled = false/);
  });

  it("never writes an endpoint key — that shape trips the upstream repair", () => {
    // The harness force-re-enables a [sponsors] section holding exactly
    // enabled=false PLUS its default endpoint (it reads that pair as
    // machine-written); a bare enabled=false is respected. MUTATION-PROOF:
    // add `endpoint = "..."` to the section and this fails.
    expect(managedConfigToml).not.toMatch(/endpoint/);
  });
});

describe("the managed config's native-provider pin", () => {
  it("the static base pins no provider — the pin is added only on a grant", () => {
    // MUTATION-PROOF: the canonical config must stay provider-neutral, so a
    // launch with no native grant writes exactly these bytes and the
    // trap-assertions above keep matching. Baking default_provider into the
    // base would silently pin every agent, Anthropic grants included.
    expect(managedConfigToml).not.toMatch(/default_provider/);
    expect(managedConfigTomlWithProvider(undefined)).toBe(managedConfigToml);
  });

  it.each(["opencode-go", "openrouter"] as const)(
    "adds [provider] default_provider = %s when the grant names it",
    (provider) => {
      // The DECLARATION half of the pin (the launch's JCODE_PROVIDER env is
      // the reload-fingerprinted fence). Verified live: default_provider =
      // "opencode-go" makes getRuntimeInfo() report provider "OpenCode Go".
      const pinned = managedConfigTomlWithProvider(provider);
      expect(pinned).toMatch(
        new RegExp(`\\[provider\\]\\ndefault_provider = "${provider}"`),
      );
      // The insert must not clobber the section's existing key.
      expect(pinned).toMatch(/stream_idle_timeout_secs = 300/);
    },
  );

  it("keeps every load-bearing section intact under the pin", () => {
    // The pin is an ADDITION: the sponsor trap, the tool-surface fence, the
    // update opt-out, and the swarm switch must all survive it.
    const pinned = managedConfigTomlWithProvider("opencode-go");
    expect(pinned).toMatch(/\[tools\]\nmcp_tools = "eager"/);
    expect(pinned).toMatch(/check_updates = false/);
    expect(pinned).toMatch(/swarm = true/);
    expect(pinned).toMatch(/\[sponsors\]\nenabled = false/);
    expect(pinned).not.toMatch(/endpoint/);
  });
});

describe("the managed config's local-endpoint pin", () => {
  const baseUrl = "http://192.168.1.50:11434/v1";

  it("adds no provider block when no local endpoint is configured — the base stays byte-identical", () => {
    // With LOCAL_LLM_BASE_URL unset, resolveNativeProvider returns undefined and
    // the launch writes the canonical static template untouched. The "local"
    // id with no config is an unreachable state (resolveNativeProvider gates on
    // the base URL), but even then it must not fabricate a profile: it adds no
    // base URL and no [providers.*] block.
    expect(managedConfigTomlWithProvider(undefined)).toBe(managedConfigToml);
    expect(managedConfigTomlWithProvider("local")).not.toMatch(/\[providers\./);
    expect(managedConfigTomlWithProvider("opencode-go")).not.toMatch(
      /\[providers\./,
    );
  });

  it("declares default_provider=local plus the [providers.local] profile WITH api_key_env when a key exists", () => {
    // The exact shape the bundled jcode's `provider add` writes for an
    // OpenAI-compatible profile with an env-sourced key (captured from the
    // pinned binary). The key VALUE is never here — only the env var NAME,
    // which jcode reads from the inherited sandbox env at request time.
    const config = managedConfigTomlWithProvider("local", {
      baseUrl,
      hasApiKey: true,
    });
    expect(config).toContain('[provider]\ndefault_provider = "local"');
    expect(config).toContain(`[providers.local]
type = "openai-compatible"
base_url = "${baseUrl}"
auth = "bearer"
api_key_env = "LOCAL_LLM_API_KEY"
requires_api_key = true`);
    // The load-bearing sections survive the appended profile.
    expect(config).toContain("[sponsors]\nenabled = false");
    expect(config).toMatch(/check_updates = false/);
    // No literal secret: the profile names the env var, it does not carry a key.
    expect(config).not.toMatch(/sk-|placeholder/);
  });

  it("omits api_key_env and pins auth=none when no key exists", () => {
    // jcode's own no-key shape (its `--no-api-key` / `--auth none`): a
    // keyless localhost server must bind without one.
    const config = managedConfigTomlWithProvider("local", {
      baseUrl,
      hasApiKey: false,
    });
    expect(config).toContain(`[providers.local]
type = "openai-compatible"
base_url = "${baseUrl}"
auth = "none"
requires_api_key = false`);
    expect(config).not.toContain("api_key_env");
  });

  it("escapes a base URL containing quotes so the TOML cannot be corrupted", () => {
    const config = managedConfigTomlWithProvider("local", {
      baseUrl: 'http://host/v1"x',
      hasApiKey: false,
    });
    expect(config).toContain('base_url = "http://host/v1\\"x"');
  });
});

describe("the native-provider model prefix", () => {
  it("prefixes a bare model when pinned to local", () => {
    // The frozen contract: the control plane's model must route to the local
    // profile, so it leaves as `local:<model>`. Verified against the pinned
    // binary: a bare id resolves through the auto route (OpenRouter), while
    // `local:<model>` resolves the provider back to `local`.
    expect(toJcodeModel("llama3", "local")).toBe("local:llama3");
    expect(toJcodeModel("qwen2.5-coder", "local")).toBe("local:qwen2.5-coder");
  });

  it("never double-prefixes an already-qualified id", () => {
    // The guard the mock-provider suite relies on: `mockai:mock-model` must
    // not become `local:mockai:mock-model`.
    expect(toJcodeModel("local:llama3", "local")).toBe("local:llama3");
    expect(toJcodeModel("opencode-go:glm-5", "local")).toBe(
      "opencode-go:glm-5",
    );
  });

  it("leaves the id bare when nothing is pinned, and keeps the other provider prefixes", () => {
    expect(toJcodeModel("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(toJcodeModel("glm-5", "opencode-go")).toBe("opencode-go:glm-5");
    expect(toJcodeModel("anthropic/claude-3", "openrouter")).toBe(
      "openrouter:anthropic/claude-3",
    );
  });
});

describe("the swarm posture: always on, fenced by env", () => {
  it("the managed config turns the subsystem ON — the switch, not the fence", () => {
    // MUTATION-PROOF: flip the byte and this fails. Fan-out is a product
    // default for every hosted agent; the limits live in the launch env
    // below, never in this agent-writable, hot-reloaded file.
    expect(managedConfigToml).toMatch(/swarm = true/);
  });

  it("the launch env pins the REAL limits — cap and headless spawns", () => {
    // MUTATION-PROOF: these strings are what jcode's env_overrides parse,
    // and env beats config.toml on every reload (both keys are in the
    // v0.78.1 reload fingerprint) — this constant IS the launch env value,
    // same law as JCODE_DISABLED_TOOLS_VALUE. The cap is enforced at the
    // harness's spawn-admission gate (worker #9 is refused server-side);
    // without it the upstream default is 32 concurrent workers.
    expect(JCODE_SWARM_ENV).toEqual({
      JCODE_SWARM_MAX_CONCURRENT_AGENTS: String(SWARM_WORKER_CAP),
      JCODE_SWARM_SPAWN_MODE: "headless",
    });
    expect(SWARM_WORKER_CAP).toBe(8);
  });

  it("pins provider-native web search on, with a usable per-request cap", () => {
    // Scraped search (DDG/Bing/Google) from sandbox egress gets CAPTCHA'd
    // after a handful of requests (prod, 2026-09-29). Native search runs on
    // the provider's side. Env, not config.toml: env overrides re-apply on
    // every config reload, so an agent cannot switch scraping back on.
    expect(JCODE_WEBSEARCH_ENV).toEqual({
      JCODE_WEBSEARCH_PREFER_NATIVE: "1",
      JCODE_WEBSEARCH_NATIVE_MAX_USES: String(WEBSEARCH_NATIVE_MAX_USES),
    });
    // Upstream's default of 5 stops a single enrichment turn mid-list.
    expect(WEBSEARCH_NATIVE_MAX_USES).toBeGreaterThan(5);
    // Native search is attached only when the session offers `websearch`.
    expect(JCODE_DISABLED_TOOLS_VALUE.split(",")).not.toContain("websearch");
  });

  it("the effort map can never hand jcode a swarm sentinel", () => {
    // jcode's effort vocabulary includes the sentinels "swarm" and
    // "swarm-deep", and swarm-deep on the ROOT session is the one unlock
    // for recursive worker spawning. This map is the platform's only door
    // to setReasoningEffort, so it staying sentinel-free IS the
    // no-recursion guarantee. MUTATION-PROOF: add a sentinel and this
    // fails.
    expect(Object.values(JCODE_EFFORT).sort()).toEqual([
      "high",
      "low",
      "max",
      "medium",
    ]);
  });

  it("the prompt block states the cap, the flat-fan-out law, and hygiene", () => {
    expect(SWARM_LIGHT_PROMPT).toContain(`at most ${SWARM_WORKER_CAP} helpers`);
    expect(SWARM_LIGHT_PROMPT).toContain("helpers never\nspawn their own");
    expect(SWARM_LIGHT_PROMPT).toContain("headless");
    // The sentinel/deep-mode ban: enforcement is the harness's (root-only
    // spawning + the effort map above); the prompt keeps the model from
    // burning turns discovering the walls.
    expect(SWARM_LIGHT_PROMPT).toContain('Never pass "swarm" or "swarm-deep"');
    expect(SWARM_LIGHT_PROMPT).toContain("deep mode");
    // The startup-race insurance (observed live: first spawn after a
    // swarm-enabled restart can refuse while membership settles).
    expect(SWARM_LIGHT_PROMPT).toContain("retry once");
    // The idle-helper hygiene rule (observed live: finished helpers sat
    // "ready" holding server memory until asked about — and a finished
    // worker keeps consuming a cap slot until stopped or reaped).
    expect(SWARM_LIGHT_PROMPT).toContain("stop or clean up");
    // The deliverable-extraction laws (observed live: every relay of helper
    // text truncates long content, a message to a completed helper drops
    // after reporting success, and a stop before collection loses the
    // deliverable for good). Raw pins — each fragment sits inside one
    // physical line of the block, like the pins above.
    expect(SWARM_LIGHT_PROMPT).toContain("name an exact file path");
    expect(SWARM_LIGHT_PROMPT).toContain("one at a time");
    expect(SWARM_LIGHT_PROMPT).toContain("already completed");
    expect(SWARM_LIGHT_PROMPT).toContain("verified in hand");
  });
});
