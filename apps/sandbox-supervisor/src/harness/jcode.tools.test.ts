import { describe, expect, it } from "vitest";
import {
  JCODE_DISABLED_TOOLS_VALUE,
  JCODE_EFFORT,
  JCODE_SWARM_ENV,
  managedConfigToml,
  SWARM_LIGHT_PROMPT,
  SWARM_WORKER_CAP,
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
    // kill the platform-tools bridge.
    expect(JCODE_DISABLED_TOOLS_VALUE).toBe(
      "schedule,skill_manage,gmail,integration_tools,memory,maintainer_feedback,jcode_docs",
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
