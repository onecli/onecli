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
}));

vi.mock("@1jehuang/jcode-sdk", () => ({
  bundledJcodeBinary: () => sdk.bundled,
  JcodeClient: class {},
  launchInstance: () => Promise.reject(new Error("not launched in this suite")),
}));

const {
  cleanJcodeKnowledgeStores,
  cleanJcodeUpdaterState,
  createJcodeHarness,
  JCODE_DISABLED_TOOLS_VALUE,
  resolveJcodeBinary,
} = await import("./jcode");

let home: string;
let outside: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "jcode-home-"));
  outside = mkdtempSync(join(tmpdir(), "jcode-outside-"));
  sdk.bundled = undefined;
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

describe("the disabled native tools", () => {
  it("memory is in the exact constant the launch env reads", () => {
    // The write-back amendment's lockdown: [features] memory=false alone
    // leaves the native tool callable (v0.71.1, still true in v0.78.1) —
    // only this list removes it from the model's definitions.
    expect(JCODE_DISABLED_TOOLS_VALUE.split(",")).toContain("memory");
  });
});

describe("native background-task observation", () => {
  it("the adapter declares its background-task provider (step 10 addendum)", () => {
    // The agent's background reflex is native — the platform observes it
    // (jcode-background.ts) rather than disabling it (turn-fatal upstream).
    expect(createJcodeHarness().backgroundTasks).toBeDefined();
  });
});
