import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The jcode version pin (plans/v2-todo.md ⭐ item): the runtime self-updates
 * by default and its daemon prefers self-downloaded builds over the spawned
 * binary, so the pin is three parts — a vendored binary the adapter refuses
 * to guess around, JCODE_NO_AUTO_UPDATE in every spawn, and per-boot removal
 * of the updater's on-disk state. These tests pin the two pure halves; the
 * launch wiring is covered by the live conformance run (a stubbed
 * JcodeClient would only test the stub).
 */

const sdk = vi.hoisted(() => ({
  bundled: undefined as string | undefined,
  /** How often the SDK's bundled lookup ran: a pinned boot must never ask. */
  bundledLookups: 0,
}));

vi.mock("@1jehuang/jcode-sdk", () => ({
  bundledJcodeBinary: () => {
    sdk.bundledLookups += 1;
    return sdk.bundled;
  },
  JcodeClient: class {},
  launchInstance: () => Promise.reject(new Error("not launched in this suite")),
}));

const {
  cleanJcodeKnowledgeStores,
  cleanJcodeUpdaterState,
  createJcodeHarness,
  resolveAnthropicCredential,
  resolveJcodeBinary,
  resolveLocalProvider,
  resolveNativeProvider,
} = await import("./jcode");

let home: string;
let outside: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "jcode-home-"));
  outside = mkdtempSync(join(tmpdir(), "jcode-outside-"));
  sdk.bundled = undefined;
  sdk.bundledLookups = 0;
  delete process.env.ONECLI_JCODE_BINARY;
});

afterEach(() => {
  delete process.env.ONECLI_JCODE_BINARY;
});

describe("resolveJcodeBinary", () => {
  it("prefers the image's pinned binary when the env var is set", () => {
    const pinned = join(outside, "jcode");
    writeFileSync(pinned, "#!");
    process.env.ONECLI_JCODE_BINARY = pinned;
    // Even with a bundled binary available, the pin wins.
    const bundled = join(outside, "bundled-jcode");
    writeFileSync(bundled, "#!");
    sdk.bundled = bundled;

    expect(resolveJcodeBinary()).toBe(pinned);
    // The image installs the SDK's platform package and deletes its binary
    // (docker/agent.Dockerfile), so the SDK's lookup is never consulted
    // under a pin: a boot on the vendored runtime cannot be steered by
    // whatever the npm package happens to ship.
    expect(sdk.bundledLookups).toBe(0);
  });

  it("a pin pointing at a missing file is a LOUD boot failure, never a fallback", () => {
    process.env.ONECLI_JCODE_BINARY = join(outside, "not-there");
    const bundled = join(outside, "bundled-jcode");
    writeFileSync(bundled, "#!");
    sdk.bundled = bundled;

    expect(() => resolveJcodeBinary()).toThrow("ONECLI_JCODE_BINARY");
  });

  it("falls back to the SDK's bundled binary outside the image (local dev)", () => {
    const bundled = join(outside, "bundled-jcode");
    writeFileSync(bundled, "#!");
    sdk.bundled = bundled;

    expect(resolveJcodeBinary()).toBe(bundled);
  });

  it("never degrades to the SDK's PATH guess: nothing resolvable throws", () => {
    // Unresolved platform package…
    sdk.bundled = undefined;
    expect(() => resolveJcodeBinary()).toThrow("No jcode runtime");
    // …and a resolved-but-deleted one (the image prunes the npm binary).
    sdk.bundled = join(outside, "deleted-bundled");
    expect(() => resolveJcodeBinary()).toThrow("No jcode runtime");
  });
});

describe("resolveAnthropicCredential", () => {
  // The route values are jcode's own `JCODE_RUNTIME_PROVIDER` vocabulary:
  // `claude` pins the Claude subscription (OAuth) route, `claude-api` the
  // direct API-key route. Anything else would be silently ignored upstream
  // and leave the runtime in automatic mode, the defect this pin closes.
  it.each([
    {
      name: "an OAuth grant pins the subscription route and keeps the stub",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "placeholder" },
      expected: { route: "claude", oauthStub: true },
    },
    {
      name: "an API-key grant pins the key route and has no stub",
      env: { ANTHROPIC_API_KEY: "placeholder" },
      expected: { route: "claude-api", oauthStub: false },
    },
    {
      name: "both set: the API key wins, never a half-OAuth launch",
      env: {
        ANTHROPIC_API_KEY: "placeholder",
        CLAUDE_CODE_OAUTH_TOKEN: "placeholder",
      },
      expected: { route: "claude-api", oauthStub: false },
    },
    {
      name: "no Anthropic grant (e.g. OpenAI only) pins nothing",
      env: { OPENAI_API_KEY: "placeholder" },
      expected: { route: undefined, oauthStub: false },
    },
    {
      name: "empty values count as unset",
      env: { ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" },
      expected: { route: undefined, oauthStub: false },
    },
    {
      name: "an empty API key does not mask an OAuth grant",
      env: { ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "placeholder" },
      expected: { route: "claude", oauthStub: true },
    },
    {
      name: "native provider keys are ignored by the Anthropic resolver",
      env: {
        OPENCODE_GO_API_KEY: "placeholder",
        OPENROUTER_API_KEY: "placeholder",
      },
      expected: { route: undefined, oauthStub: false },
    },
  ])("$name", ({ env, expected }) => {
    expect(resolveAnthropicCredential(env)).toEqual(expected);
  });
});

describe("resolveNativeProvider", () => {
  // The native provider pin: opencode-go needs an explicit pin because jcode
  // has NO env auto-detect for it (verified live: with only
  // OPENCODE_GO_API_KEY set, getRuntimeInfo().provider stayed "OpenRouter");
  // openrouter has one, but the pin makes both deterministic. Anthropic always
  // wins so resolveAnthropicCredential's behavior is never shadowed.
  it.each([
    {
      name: "OPENCODE_GO_API_KEY pins OpenCode Go",
      env: { OPENCODE_GO_API_KEY: "placeholder" },
      expected: "opencode-go",
    },
    {
      name: "OPENROUTER_API_KEY pins OpenRouter",
      env: { OPENROUTER_API_KEY: "placeholder" },
      expected: "openrouter",
    },
    {
      name: "both keys: OpenCode Go wins deterministically",
      env: {
        OPENCODE_GO_API_KEY: "placeholder",
        OPENROUTER_API_KEY: "placeholder",
      },
      expected: "opencode-go",
    },
    {
      name: "an Anthropic API-key grant wins over a native key",
      env: {
        ANTHROPIC_API_KEY: "placeholder",
        OPENCODE_GO_API_KEY: "placeholder",
      },
      expected: undefined,
    },
    {
      name: "an Anthropic OAuth grant wins over a native key",
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: "placeholder",
        OPENROUTER_API_KEY: "placeholder",
      },
      expected: undefined,
    },
    {
      name: "no native grant pins nothing",
      env: { OPENAI_API_KEY: "placeholder" },
      expected: undefined,
    },
    {
      name: "empty values count as unset",
      env: { OPENCODE_GO_API_KEY: "", OPENROUTER_API_KEY: "" },
      expected: undefined,
    },
    // The local endpoint (a user-supplied OpenAI-compatible server). It is
    // gated on LOCAL_LLM_BASE_URL alone — the key is optional, because a
    // localhost model server frequently needs no auth.
    {
      name: "LOCAL_LLM_BASE_URL pins the local endpoint",
      env: { LOCAL_LLM_BASE_URL: "http://192.168.1.50:11434/v1" },
      expected: "local",
    },
    {
      name: "the local endpoint outranks a hosted native key (explicit operator intent for this agent)",
      env: {
        LOCAL_LLM_BASE_URL: "http://192.168.1.50:11434/v1",
        LOCAL_LLM_API_KEY: "placeholder",
        OPENCODE_GO_API_KEY: "placeholder",
        OPENROUTER_API_KEY: "placeholder",
      },
      expected: "local",
    },
    {
      name: "an Anthropic grant still wins over the local endpoint",
      env: {
        ANTHROPIC_API_KEY: "placeholder",
        LOCAL_LLM_BASE_URL: "http://192.168.1.50:11434/v1",
      },
      expected: undefined,
    },
    {
      name: "a key without a base URL pins nothing — the endpoint is what identifies local",
      env: { LOCAL_LLM_API_KEY: "placeholder" },
      expected: undefined,
    },
    {
      name: "an empty LOCAL_LLM_BASE_URL counts as unset",
      env: { LOCAL_LLM_BASE_URL: "" },
      expected: undefined,
    },
  ])("$name", ({ env, expected }) => {
    expect(resolveNativeProvider(env)).toBe(expected);
  });
});

describe("resolveLocalProvider", () => {
  // The provider-agnostic half of the local pin: WHAT the `[providers.local]`
  // profile points at, and whether the profile reads a key env (bearer) or
  // declares no auth at all. Gated on the base URL exactly like
  // resolveNativeProvider picks "local", so the two can never disagree.
  it("carries the base URL and reports a key when the env has one", () => {
    expect(
      resolveLocalProvider({
        LOCAL_LLM_BASE_URL: "http://192.168.1.50:11434/v1",
        LOCAL_LLM_API_KEY: "placeholder",
      }),
    ).toEqual({ baseUrl: "http://192.168.1.50:11434/v1", hasApiKey: true });
  });

  it("reports no key when only the base URL is set (a keyless local server)", () => {
    expect(
      resolveLocalProvider({
        LOCAL_LLM_BASE_URL: "http://192.168.1.50:11434/v1",
      }),
    ).toEqual({ baseUrl: "http://192.168.1.50:11434/v1", hasApiKey: false });
  });

  it("is undefined with no base URL — even if a stray key is set", () => {
    expect(resolveLocalProvider({})).toBeUndefined();
    expect(
      resolveLocalProvider({ LOCAL_LLM_API_KEY: "placeholder" }),
    ).toBeUndefined();
    expect(resolveLocalProvider({ LOCAL_LLM_BASE_URL: "" })).toBeUndefined();
  });
});

describe("cleanJcodeUpdaterState", () => {
  it("removes exactly the updater's state and leaves the session home alone", () => {
    // The updater's artifacts, as observed on a real self-updated volume.
    mkdirSync(join(home, "builds/versions/0.71.1"), { recursive: true });
    writeFileSync(join(home, "builds/versions/0.71.1/jcode"), "elf");
    writeFileSync(join(home, "builds/stable-version"), "v0.71.1");
    mkdirSync(join(home, "bin"));
    symlinkSync(
      join(home, "builds/versions/0.71.1/jcode"),
      join(home, "bin/jcode"),
    );
    writeFileSync(join(home, "update_metadata.json"), "{}");
    // The other on-volume executable stash (upstream since v0.76, purged
    // since our v0.78.1 pin): a managed provider CLI jcode execs when that
    // provider is selected.
    mkdirSync(join(home, "provider-backends/grok-build"), { recursive: true });
    writeFileSync(join(home, "provider-backends/grok-build/grok"), "elf");
    // The third stash (purged since the browser-tool disable, 2026-09-09):
    // `jcode browser setup` drops the Firefox bridge's native-messaging host
    // and a helper binary here, and the tool execs them.
    mkdirSync(join(home, "browser"));
    writeFileSync(join(home, "browser/firefox-agent-bridge-host"), "elf");
    writeFileSync(join(home, "browser/browser-agent-bridge.xpi"), "zip");
    // What must SURVIVE: the agent's sessions and our managed files.
    mkdirSync(join(home, "sessions"));
    writeFileSync(join(home, "sessions/s1.jsonl"), "{}");
    writeFileSync(join(home, "auth.json"), "{}");
    writeFileSync(join(home, "config.toml"), "#");

    cleanJcodeUpdaterState(home);

    expect(existsSync(join(home, "builds"))).toBe(false);
    expect(existsSync(join(home, "bin"))).toBe(false);
    expect(existsSync(join(home, "update_metadata.json"))).toBe(false);
    expect(existsSync(join(home, "provider-backends"))).toBe(false);
    expect(existsSync(join(home, "browser"))).toBe(false);
    expect(readFileSync(join(home, "sessions/s1.jsonl"), "utf8")).toBe("{}");
    expect(existsSync(join(home, "auth.json"))).toBe(true);
    expect(existsSync(join(home, "config.toml"))).toBe(true);
  });

  it("is idempotent on a home with no updater state (the pinned steady state)", () => {
    writeFileSync(join(home, "auth.json"), "{}");
    expect(() => cleanJcodeUpdaterState(home)).not.toThrow();
    expect(() => cleanJcodeUpdaterState(home)).not.toThrow();
    expect(existsSync(join(home, "auth.json"))).toBe(true);
  });

  it("unlinks a planted symlink as a LINK — the target outside survives", () => {
    // The home lives on the agent-writable volume: an agent could plant
    // `builds -> somewhere` hoping the boot cleanup follows it.
    const target = join(outside, "precious");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "keep");
    symlinkSync(target, join(home, "builds"));

    cleanJcodeUpdaterState(home);

    expect(lstatSync(join(home, "builds"), { throwIfNoEntry: false })).toBe(
      undefined,
    );
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("keep");
  });
});

describe("cleanJcodeKnowledgeStores", () => {
  it("purges the native memory/notes graphs and every unmanaged skill stash", () => {
    // MUTATION-PROOF for the no-alternatives law: drop any path from the
    // purge list and its case here fails — that path is durable,
    // platform-invisible knowledge ([features] memory=false does NOT remove
    // the native memory tool; verified in v0.71.1, still true in v0.78.1).
    // The external/ trio matters doubly: jcode's first-run import copies
    // external/.claude/skills + external/.codex/skills into the live
    // registry whenever $JCODE_HOME/skills is absent — which this very
    // purge guarantees each boot — and external/.claude/plugins is a global
    // skill source scanned on existence.
    const agentHome = mkdtempSync(join(tmpdir(), "jcode-agent-home-"));
    for (const dir of [
      join(home, "memory"),
      join(home, "notes"),
      join(home, "skills", "stash"),
      join(home, "external", ".agents", "skills", "stash"),
      join(home, "external", ".claude", "skills", "stash"),
      join(home, "external", ".claude", "plugins", "stash"),
      join(home, "external", ".codex", "skills", "stash"),
      join(agentHome, ".jcode", "skills", "stash"),
      join(agentHome, ".claude", "skills", "stash"),
      // The durable POSIX home (~ = <homeDir>/.home): every user-home stash
      // path jcode's resolver knows, now persistent across relaunch — a
      // planted skill there would re-enter the registry durably.
      join(agentHome, ".home", ".agents", "skills", "stash"),
      join(agentHome, ".home", ".jcode", "skills", "stash"),
      join(agentHome, ".home", ".claude", "skills", "stash"),
      join(agentHome, ".home", ".claude", "plugins", "stash"),
      join(agentHome, ".home", ".codex", "skills", "stash"),
    ]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "data.json"), "{}");
    }
    // What must SURVIVE: sessions (resume), goals, and the managed skills
    // root (the sync channel owns it).
    mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(join(home, "sessions", "s1.json"), "{}");
    mkdirSync(join(agentHome, ".agents", "skills", "managed"), {
      recursive: true,
    });
    writeFileSync(
      join(agentHome, ".agents", "skills", "managed", "SKILL.md"),
      "# managed",
    );

    cleanJcodeKnowledgeStores(agentHome, home);

    expect(existsSync(join(home, "memory"))).toBe(false);
    expect(existsSync(join(home, "notes"))).toBe(false);
    expect(existsSync(join(home, "skills"))).toBe(false);
    expect(existsSync(join(home, "external", ".agents", "skills"))).toBe(false);
    expect(existsSync(join(home, "external", ".claude", "skills"))).toBe(false);
    expect(existsSync(join(home, "external", ".claude", "plugins"))).toBe(
      false,
    );
    expect(existsSync(join(home, "external", ".codex", "skills"))).toBe(false);
    expect(existsSync(join(agentHome, ".jcode", "skills"))).toBe(false);
    expect(existsSync(join(agentHome, ".claude", "skills"))).toBe(false);
    expect(existsSync(join(agentHome, ".home", ".agents", "skills"))).toBe(
      false,
    );
    expect(existsSync(join(agentHome, ".home", ".jcode", "skills"))).toBe(
      false,
    );
    expect(existsSync(join(agentHome, ".home", ".claude", "skills"))).toBe(
      false,
    );
    expect(existsSync(join(agentHome, ".home", ".claude", "plugins"))).toBe(
      false,
    );
    expect(existsSync(join(agentHome, ".home", ".codex", "skills"))).toBe(
      false,
    );
    expect(existsSync(join(home, "sessions", "s1.json"))).toBe(true);
    expect(
      existsSync(join(agentHome, ".agents", "skills", "managed", "SKILL.md")),
    ).toBe(true);
  });

  it("unlinks a planted symlink as a LINK — the target outside survives", () => {
    const agentHome = mkdtempSync(join(tmpdir(), "jcode-agent-home-"));
    writeFileSync(join(outside, "precious.txt"), "keep me");
    symlinkSync(outside, join(home, "memory"));

    cleanJcodeKnowledgeStores(agentHome, home);

    expect(existsSync(join(home, "memory"))).toBe(false);
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep me");
  });
});

describe("native background-task observation", () => {
  it("the adapter declares its background-task provider (step 10 addendum)", () => {
    // The agent's background reflex is native — the platform observes it
    // (jcode-background.ts) rather than disabling it (turn-fatal upstream).
    expect(createJcodeHarness().backgroundTasks).toBeDefined();
  });
});
