import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  renderMemoryFile,
  type SupervisorMessage,
  type WorkItem,
} from "@onecli/agent-protocol";
import { applyHomeSync } from "./materializer";
import type { MemoryHarvester, HarvestOutcome } from "./memory-harvest";
import type { RenderInputs } from "./renderer";

/**
 * The materializer against a real tmpdir — the containment laws (symlink
 * parents, non-managed roots, prune confinement), idempotency (mtime is
 * evidence), part semantics (prune/ack final-only, re-ack on repeat), the
 * mid-run re-render, and the write-back laws (agent-authored bytes under
 * memory/ are harvested and spared; only checksum-verified projections are
 * overwritten or pruned).
 */

type SyncItem = Extract<WorkItem, { kind: "skills.changed" }>;

let home: string;
let outside: string;
let sent: SupervisorMessage[];
let inputs: RenderInputs;

const send = (message: SupervisorMessage) => {
  sent.push(message);
};

/** A checksum-valid projection body — what a platform render looks like on
 * disk (the only thing the materializer may overwrite or prune). */
const projection = (key: string, content: string): string =>
  renderMemoryFile({ key, title: null, description: null, content });

const stubHarvester = (
  outcome: HarvestOutcome,
): MemoryHarvester & { harvested: string[]; forgotten: string[] } => {
  const harvested: string[] = [];
  const forgotten: string[] = [];
  return {
    harvested,
    forgotten,
    poll: async () => undefined,
    harvestFile: async (fileName: string) => {
      harvested.push(fileName);
      return outcome;
    },
    forgetFile: (fileName: string) => {
      forgotten.push(fileName);
    },
    handleResult: () => undefined,
    stop: () => undefined,
  };
};

const item = (overrides: Partial<SyncItem> = {}): SyncItem => ({
  kind: "skills.changed",
  generation: 1,
  part: 1,
  of: 1,
  files: [],
  prune: [],
  ...overrides,
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "materializer-ws-"));
  outside = mkdtempSync(join(tmpdir(), "materializer-outside-"));
  sent = [];
  inputs = {
    instructions: "boot brief",
    agentName: "Ada",
    capabilities: {
      resume: true,
      thinking: false,
      toolEvents: true,
      steer: true,
      skillsDir: ".agents/skills",
      instructionFiles: ["CLAUDE.md", "AGENTS.md"],
    },
    fragments: [],
  };
});

describe("writes", () => {
  it("writes skills 0444 and memory files 0644; memory/index.md stays 0444", async () => {
    await applyHomeSync(
      home,
      item({
        files: [
          { path: ".agents/skills/deploy/SKILL.md", content: "# deploy" },
          { path: "memory/staging-url.md", content: "# staging" },
          { path: "memory/index.md", content: "# Memory index" },
        ],
        prune: [
          ".agents/skills/deploy/SKILL.md",
          "memory/staging-url.md",
          "memory/index.md",
        ],
      }),
      inputs,
      send,
    );
    const skill = join(home, ".agents/skills/deploy/SKILL.md");
    expect(readFileSync(skill, "utf8")).toBe("# deploy");
    expect(statSync(skill).mode & 0o777).toBe(0o444);
    const memoryFile = join(home, "memory/staging-url.md");
    expect(readFileSync(memoryFile, "utf8")).toBe("# staging");
    // Agent-writable by design — the working copy of platform memory.
    expect(statSync(memoryFile).mode & 0o777).toBe(0o644);
    // The generated map stays read-only.
    expect(statSync(join(home, "memory/index.md")).mode & 0o777).toBe(0o444);
    expect(sent).toEqual([{ kind: "home.synced", generation: 1 }]);
  });

  it("reconciles a stale 0444 mode on byte-identical memory files (the pre-amendment volume)", async () => {
    mkdirSync(join(home, "memory"), { recursive: true });
    writeFileSync(join(home, "memory/fact.md"), "same", { mode: 0o444 });
    await applyHomeSync(
      home,
      item({
        files: [{ path: "memory/fact.md", content: "same" }],
        prune: ["memory/fact.md"],
      }),
      inputs,
      send,
    );
    expect(statSync(join(home, "memory/fact.md")).mode & 0o777).toBe(0o644);
  });

  it("re-applying identical content leaves mtimes untouched — and still re-acks", async () => {
    const sync = item({
      files: [{ path: "memory/fact.md", content: "same" }],
      prune: ["memory/fact.md"],
    });
    await applyHomeSync(home, sync, inputs, send);
    const before = statSync(join(home, "memory/fact.md")).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await applyHomeSync(home, sync, inputs, send);
    expect(statSync(join(home, "memory/fact.md")).mtimeMs).toBe(before);
    // The re-ack law: the previous ack may be exactly what was dropped.
    expect(sent).toHaveLength(2);
  });
});

describe("containment", () => {
  it("refuses a path outside the managed roots, applying the rest", async () => {
    await applyHomeSync(
      home,
      item({
        files: [
          { path: ".jcode-home/config.toml", content: "evil" },
          { path: "memory/good.md", content: "good" },
        ],
        prune: ["memory/good.md"],
      }),
      inputs,
      send,
    );
    expect(existsSync(join(home, ".jcode-home/config.toml"))).toBe(false);
    expect(readFileSync(join(home, "memory/good.md"), "utf8")).toBe("good");
  });

  it("a planted symlink PARENT is replaced with a real dir — the target untouched", async () => {
    // The v2-todo parent-directory gap, now load-bearing: the agent plants
    // .agents/skills/evil -> <outside>; a recursive mkdir would accept it and
    // the write would land outside the home.
    mkdirSync(join(home, ".agents/skills"), { recursive: true });
    symlinkSync(outside, join(home, ".agents/skills/evil"));

    await applyHomeSync(
      home,
      item({
        files: [{ path: ".agents/skills/evil/SKILL.md", content: "# safe" }],
        prune: [".agents/skills/evil/SKILL.md"],
      }),
      inputs,
      send,
    );

    const dir = join(home, ".agents/skills/evil");
    expect(lstatSync(dir).isSymbolicLink()).toBe(false);
    expect(lstatSync(dir).isDirectory()).toBe(true);
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe("# safe");
    // The outside dir got NOTHING.
    expect(existsSync(join(outside, "SKILL.md"))).toBe(false);
  });

  it("a planted symlink at the FILE position is unlinked, never followed", async () => {
    mkdirSync(join(home, "memory"), { recursive: true });
    const target = join(outside, "target.md");
    writeFileSync(target, "original");
    symlinkSync(target, join(home, "memory/fact.md"));

    await applyHomeSync(
      home,
      item({
        files: [{ path: "memory/fact.md", content: "ours" }],
        prune: ["memory/fact.md"],
      }),
      inputs,
      send,
    );

    expect(readFileSync(target, "utf8")).toBe("original");
    expect(lstatSync(join(home, "memory/fact.md")).isSymbolicLink()).toBe(
      false,
    );
    expect(readFileSync(join(home, "memory/fact.md"), "utf8")).toBe("ours");
  });

  it("a symlink whose target has BYTE-IDENTICAL content is still replaced", async () => {
    // The idempotent skip must never keep a link alive: content equality
    // through a followed link would let the agent later rewrite the target
    // behind the managed path. lstat decides — not-a-regular-file always
    // rewrites.
    mkdirSync(join(home, "memory"), { recursive: true });
    const target = join(outside, "identical.md");
    writeFileSync(target, "same bytes");
    symlinkSync(target, join(home, "memory/fact.md"));

    await applyHomeSync(
      home,
      item({
        files: [{ path: "memory/fact.md", content: "same bytes" }],
        prune: ["memory/fact.md"],
      }),
      inputs,
      send,
    );

    expect(lstatSync(join(home, "memory/fact.md")).isSymbolicLink()).toBe(
      false,
    );
    expect(readFileSync(join(home, "memory/fact.md"), "utf8")).toBe(
      "same bytes",
    );
    expect(readFileSync(target, "utf8")).toBe("same bytes");
  });
});

describe("prune", () => {
  it("removes stale skills and checksum-verified stale memory projections; outside files survive", async () => {
    mkdirSync(join(home, ".agents/skills/stale"), { recursive: true });
    writeFileSync(join(home, ".agents/skills/stale/SKILL.md"), "old");
    mkdirSync(join(home, "memory"), { recursive: true });
    // A CHECKSUM-VALID projection whose memory was deleted platform-side —
    // the one thing prune may remove under memory/ (the "dashboard delete
    // while parked" case actually landing).
    writeFileSync(join(home, "memory/stale.md"), projection("stale", "old"));
    writeFileSync(join(home, "notes.txt"), "the agent's own file");

    await applyHomeSync(
      home,
      item({
        files: [{ path: "memory/kept.md", content: "kept" }],
        prune: ["memory/kept.md"],
      }),
      inputs,
      send,
    );

    expect(existsSync(join(home, ".agents/skills/stale"))).toBe(false);
    expect(existsSync(join(home, "memory/stale.md"))).toBe(false);
    expect(readFileSync(join(home, "memory/kept.md"), "utf8")).toBe("kept");
    // Prune never leaves the managed roots.
    expect(readFileSync(join(home, "notes.txt"), "utf8")).toBe(
      "the agent's own file",
    );
  });

  it("HARVESTS agent files outside the manifest before touching them; uploaded bytes may then go", async () => {
    // MUTATION-PROOF for the no-silent-loss law: replace pruneMemoryRoot
    // with the plain manifest prune and this fails on `harvested` — the
    // agent's un-synced memory would die UN-uploaded at the very next
    // dashboard edit. Once uploaded the file itself may go: a fresh
    // upload's bump re-projects it, and a ledger hit on a manifest-absent
    // key is a landed platform delete.
    mkdirSync(join(home, "memory"), { recursive: true });
    writeFileSync(join(home, "memory/my-note.md"), "agent wrote this");
    const harvester = stubHarvester("uploaded");

    await applyHomeSync(
      home,
      item({ files: [], prune: [] }),
      inputs,
      send,
      harvester,
    );

    expect(harvester.harvested).toEqual(["my-note.md"]);
    expect(existsSync(join(home, "memory/my-note.md"))).toBe(false);
  });

  it("spares a REFUSED agent file too — refusal is a warning, never a deletion", async () => {
    mkdirSync(join(home, "memory"), { recursive: true });
    writeFileSync(join(home, "memory/too-big.md"), "oversize");
    const harvester = stubHarvester("refused");

    await applyHomeSync(
      home,
      item({ files: [], prune: [] }),
      inputs,
      send,
      harvester,
    );

    expect(readFileSync(join(home, "memory/too-big.md"), "utf8")).toBe(
      "oversize",
    );
  });

  it("keeps non-harvestable names under memory/ (agent data) and deletes an orphaned index.md", async () => {
    mkdirSync(join(home, "memory"), { recursive: true });
    writeFileSync(join(home, "memory/Not A Key.txt"), "kept");
    // The generated map with zero memories left: manifest-absent → deleted.
    writeFileSync(join(home, "memory/index.md"), "# Memory index");

    await applyHomeSync(
      home,
      item({ files: [], prune: [] }),
      inputs,
      send,
      stubHarvester("uploaded"),
    );

    expect(readFileSync(join(home, "memory/Not A Key.txt"), "utf8")).toBe(
      "kept",
    );
    expect(existsSync(join(home, "memory/index.md"))).toBe(false);
  });

  it("a symlink under a managed root is unlinked as a link — its target intact", async () => {
    mkdirSync(join(home, "memory"), { recursive: true });
    const target = join(outside, "keepme");
    mkdirSync(target);
    writeFileSync(join(target, "f.txt"), "outside");
    symlinkSync(target, join(home, "memory/link"));

    await applyHomeSync(home, item({ files: [], prune: [] }), inputs, send);

    expect(existsSync(join(home, "memory/link"))).toBe(false);
    expect(readFileSync(join(target, "f.txt"), "utf8")).toBe("outside");
  });
});

describe("parts", () => {
  it("prune and ack ride the FINAL part only", async () => {
    mkdirSync(join(home, "memory"), { recursive: true });
    writeFileSync(join(home, "memory/stale.md"), projection("stale", "old"));

    await applyHomeSync(
      home,
      item({
        part: 1,
        of: 2,
        files: [{ path: "memory/a.md", content: "a" }],
        prune: undefined,
      }),
      inputs,
      send,
    );
    // Mid-generation: nothing pruned, nothing acked.
    expect(existsSync(join(home, "memory/stale.md"))).toBe(true);
    expect(sent).toEqual([]);

    await applyHomeSync(
      home,
      item({
        part: 2,
        of: 2,
        files: [{ path: "memory/b.md", content: "b" }],
        prune: ["memory/a.md", "memory/b.md"],
      }),
      inputs,
      send,
    );
    expect(existsSync(join(home, "memory/stale.md"))).toBe(false);
    expect(sent).toEqual([{ kind: "home.synced", generation: 1 }]);
  });
});

describe("the overwrite gate (write-back)", () => {
  it("overwrites a checksum-verified stale projection freely", async () => {
    mkdirSync(join(home, "memory"), { recursive: true });
    writeFileSync(
      join(home, "memory/fact.md"),
      projection("fact", "old truth"),
    );
    const harvester = stubHarvester("uploaded");

    await applyHomeSync(
      home,
      item({
        files: [
          { path: "memory/fact.md", content: projection("fact", "new truth") },
        ],
        prune: ["memory/fact.md"],
      }),
      inputs,
      send,
      harvester,
    );

    expect(readFileSync(join(home, "memory/fact.md"), "utf8")).toContain(
      "new truth",
    );
    expect(harvester.harvested).toEqual([]);
  });

  it("NEVER overwrites agent bytes the platform does not hold — a REFUSED harvest spares them", async () => {
    // MUTATION-PROOF for red-team #3: drop the checksum branch (or ignore
    // the harvest outcome) and this fails — a refused (e.g. oversized)
    // agent edit would be destroyed by the next unrelated sync.
    mkdirSync(join(home, "memory"), { recursive: true });
    writeFileSync(join(home, "memory/fact.md"), "the agent's edit");
    const harvester = stubHarvester("refused");

    await applyHomeSync(
      home,
      item({
        files: [
          {
            path: "memory/fact.md",
            content: projection("fact", "platform version"),
          },
        ],
        prune: ["memory/fact.md"],
      }),
      inputs,
      send,
      harvester,
    );

    expect(harvester.harvested).toEqual(["fact.md"]);
    expect(readFileSync(join(home, "memory/fact.md"), "utf8")).toBe(
      "the agent's edit",
    );
    // The generation still acks — divergence is warned, never wedged.
    expect(sent).toEqual([{ kind: "home.synced", generation: 1 }]);
  });

  it("an UPLOADED harvest lets the canonical render land — the convergence half", async () => {
    // MUTATION-PROOF (found live): `continue` regardless of outcome and this
    // fails — an agent-created file would never gain its checksum, because
    // harvesting already-uploaded bytes bumps no new generation, so nothing
    // ever supersedes the raw file.
    mkdirSync(join(home, "memory"), { recursive: true });
    writeFileSync(join(home, "memory/fact.md"), "the agent's edit");
    const harvester = stubHarvester("uploaded");
    const canonical = projection("fact", "the agent's edit");

    await applyHomeSync(
      home,
      item({
        files: [{ path: "memory/fact.md", content: canonical }],
        prune: ["memory/fact.md"],
      }),
      inputs,
      send,
      harvester,
    );

    expect(harvester.harvested).toEqual(["fact.md"]);
    expect(readFileSync(join(home, "memory/fact.md"), "utf8")).toBe(canonical);
  });

  it("skills never get the gate: divergent skill bytes are simply overwritten", async () => {
    mkdirSync(join(home, ".agents/skills/deploy"), { recursive: true });
    writeFileSync(
      join(home, ".agents/skills/deploy/SKILL.md"),
      "agent tampering",
    );
    const harvester = stubHarvester("uploaded");

    await applyHomeSync(
      home,
      item({
        files: [{ path: ".agents/skills/deploy/SKILL.md", content: "# real" }],
        prune: [".agents/skills/deploy/SKILL.md"],
      }),
      inputs,
      send,
      harvester,
    );

    expect(
      readFileSync(join(home, ".agents/skills/deploy/SKILL.md"), "utf8"),
    ).toBe("# real");
    expect(harvester.harvested).toEqual([]);
  });
});

describe("the mid-run re-render", () => {
  it("fresh instructions on the final part land in the instruction docs; empty string clears", async () => {
    await applyHomeSync(
      home,
      item({ instructions: "You are the NEW brief.", agentName: "Newton" }),
      inputs,
      send,
    );
    const doc = readFileSync(join(home, "CLAUDE.md"), "utf8");
    expect(doc).toContain("You are the NEW brief.");
    expect(inputs.instructions).toBe("You are the NEW brief.");
    expect(inputs.agentName).toBe("Newton");

    await applyHomeSync(
      home,
      item({ generation: 2, instructions: "", agentName: "Newton" }),
      inputs,
      send,
    );
    expect(inputs.instructions).toBeUndefined();
    expect(readFileSync(join(home, "CLAUDE.md"), "utf8")).not.toContain(
      "You are the NEW brief.",
    );
  });

  it("a null-skillsDir adapter skips skill files quietly and never creates the dir", async () => {
    inputs = {
      ...inputs,
      capabilities: { ...inputs.capabilities, skillsDir: null },
    };
    await applyHomeSync(
      home,
      item({
        files: [
          { path: ".agents/skills/x/SKILL.md", content: "skip me" },
          { path: "memory/keep.md", content: "keep" },
        ],
        prune: ["memory/keep.md"],
      }),
      inputs,
      send,
    );
    expect(existsSync(join(home, ".agents/skills"))).toBe(false);
    expect(readFileSync(join(home, "memory/keep.md"), "utf8")).toBe("keep");
    expect(sent).toHaveLength(1);
  });
});
