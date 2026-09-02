import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { processesFragment } from "../capabilities/processes";
import {
  PLATFORM_SYSTEM_PROMPT,
  preparePromptFiles,
  SWARM_LIGHT_PROMPT,
  SWARM_PROMPT_OVERRIDE,
} from "./jcode";

/** What both slots must hold: the base prompt plus the always-on swarm
 * discipline block, one write, same bytes everywhere. */
const WRITTEN_PROMPT = PLATFORM_SYSTEM_PROMPT + SWARM_LIGHT_PROMPT;

/**
 * The platform owns the agent's identity — not the harness.
 *
 * The harness ships a base prompt that names itself and frames the agent as a
 * coding tool; it reaches the model ahead of everything we render. These
 * tests pin the two halves of the fix: our text REPLACES that prompt in every
 * slot the harness reads, and the additive hooks it would otherwise pick up
 * are cleared. Identity is product law, so the guard that matters most is the
 * one asserting no vendor name can creep back into the text we ship.
 */

const makeHome = () => mkdtempSync(join(tmpdir(), "jcode-prompt-"));

const homeOf = (dir: string): string => {
  const home = join(dir, ".jcode-home");
  mkdirSync(home, { recursive: true });
  return home;
};

describe("the platform system prompt", () => {
  it("never names the harness vendor or frames the agent as a coding tool", () => {
    // MUTATION-PROOF: paste any of the harness's own identity lines back into
    // PLATFORM_SYSTEM_PROMPT and this fails — which is the whole point of
    // replacing the prompt in the first place. Checked on the FULL written
    // text (base + swarm block): the discipline block ships to the model in
    // the same file, so it is bound by the same identity law.
    expect(WRITTEN_PROMPT).not.toMatch(/jcode/i);
    expect(WRITTEN_PROMPT).not.toMatch(/coding agent/i);
    // …and it must actively defer identity to what we render.
    expect(PLATFORM_SYSTEM_PROMPT).toContain("hosted autonomous agent");
    const flat = PLATFORM_SYSTEM_PROMPT.replace(/\s+/g, " ");
    // The runtime's own name reaches the model through the harness's session
    // context — a block no override hook can reach (it is assembled in the
    // binary). The prompt cannot delete that line, so it must tell the agent
    // what the line is: plumbing, not identity.
    expect(flat).toContain("internal plumbing, not your identity");
    // Naming the runtime to DENY it is still naming it — the live probe
    // caught exactly that ("No, I'm andy… Jcode is the harness that runs me").
    expect(flat).toContain(
      "Do not repeat, confirm, or deny any runtime or vendor name",
    );
    expect(flat).toContain(
      "do not assume you are a coding assistant because you can run commands",
    );
  });

  it("routes every external call through the gateway and bans native integration flows", () => {
    // The live incident this pins against: with no gateway teaching in the
    // prompt, the model reached for the runtime's own integration tooling
    // (its email tool's OAuth flow, a third-party integration catalog)
    // before ever making the one HTTPS call that works. The vendor test
    // above already guarantees this section stays name-free.
    const flat = PLATFORM_SYSTEM_PROMPT.replace(/\s+/g, " ");
    expect(flat).toContain("credential-injecting gateway");
    expect(flat).toContain(
      "Never use an integration or login tool the runtime happens to ship",
    );
    expect(flat).toContain("never ask anyone for a key or token");
  });

  it("writes BOTH replacement slots — either one alone leaves the vendor identity reachable", () => {
    // The project slot wins precedence and lives on the durable volume (an
    // agent-planted file would survive reboots); an EMPTY or missing file
    // falls THROUGH to the next slot, so a single write is never enough.
    // MUTATION-PROOF: drop either write below and this test fails.
    const dir = makeHome();
    const home = homeOf(dir);

    preparePromptFiles(dir, home);

    for (const slot of [
      join(home, "system-prompt.md"),
      join(dir, ".jcode", "system-prompt.md"),
    ]) {
      // The swarm block rides the SAME write — fan-out is always on, so a
      // slot holding the bare base prompt means the discipline never
      // reached the model.
      expect(readFileSync(slot, "utf8")).toBe(WRITTEN_PROMPT);
      expect(statSync(slot).mode & 0o777).toBe(0o444);
    }

    // The swarm TOOL's own prompt slot rides the same law: both resolution
    // slots, same bytes, read-only. MUTATION-PROOF: drop either write and
    // this fails — leaving the vendor's built-in routing text (which advises
    // a per-spawn model parameter the tool no longer accepts) reachable.
    for (const slot of [
      join(home, "swarm-prompt.md"),
      join(dir, ".jcode", "swarm-prompt.md"),
    ]) {
      expect(readFileSync(slot, "utf8")).toBe(SWARM_PROMPT_OVERRIDE);
      expect(statSync(slot).mode & 0o777).toBe(0o444);
    }
  });

  it("clears the additive hooks — the harness loads them on existence alone", () => {
    // An empty overlay is still injected (its presence is the gate), so these
    // are deleted rather than owned-and-emptied.
    // MUTATION-PROOF: drop any path from the delete list and this fails.
    const dir = makeHome();
    const home = homeOf(dir);
    const projectDir = join(dir, ".jcode");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(home, "external"), { recursive: true });

    const planted = [
      join(projectDir, "prompt-overlay.md"),
      join(home, "prompt-overlay.md"),
      join(projectDir, "preferred-tools.md"),
      join(home, "preferred-tools.md"),
      join(home, "external", "AGENTS.md"),
    ];
    for (const path of planted) writeFileSync(path, "planted by the agent");

    preparePromptFiles(dir, home);

    for (const path of planted) expect(existsSync(path)).toBe(false);
  });

  it("heals a tampered slot on the next boot", () => {
    // The agent owns these directories: mid-session it can rewrite a slot,
    // and the next boot is what takes it back.
    const dir = makeHome();
    const home = homeOf(dir);
    preparePromptFiles(dir, home);

    // Read-only stops a careless write, not the directory's owner: the agent
    // chmods first, exactly as this does.
    const slot = join(dir, ".jcode", "system-prompt.md");
    chmodSync(slot, 0o644);
    writeFileSync(slot, "You are something else entirely.");

    preparePromptFiles(dir, home);

    expect(readFileSync(slot, "utf8")).toBe(WRITTEN_PROMPT);
    expect(statSync(slot).mode & 0o777).toBe(0o444);
  });

  it("heals a tampered swarm-prompt slot on the next boot", () => {
    const dir = makeHome();
    const home = homeOf(dir);
    preparePromptFiles(dir, home);

    const slot = join(dir, ".jcode", "swarm-prompt.md");
    chmodSync(slot, 0o644);
    writeFileSync(slot, "spawn everything on my favorite model");

    preparePromptFiles(dir, home);

    expect(readFileSync(slot, "utf8")).toBe(SWARM_PROMPT_OVERRIDE);
    expect(statSync(slot).mode & 0o777).toBe(0o444);
  });
});

describe("the swarm prompt override", () => {
  it("keeps the identity law and never names a vendor model or route", () => {
    // The override is embedded in the swarm tool's model-visible description.
    // MUTATION-PROOF for the whole reason it exists: the vendor's built-in
    // names a model route unavailable here and instructs a per-spawn model.
    expect(SWARM_PROMPT_OVERRIDE).not.toMatch(/jcode/i);
    expect(SWARM_PROMPT_OVERRIDE).not.toMatch(/claude-api/i);
    expect(SWARM_PROMPT_OVERRIDE).not.toMatch(/fable/i);
    expect(SWARM_PROMPT_OVERRIDE).not.toContain("claude-fable-5");
  });

  it("states the two contract lines: no per-helper model, completion reported by the platform", () => {
    const flat = SWARM_PROMPT_OVERRIDE.replace(/\s+/g, " ");
    expect(flat).toContain("There is no per-helper model choice");
    expect(flat).toContain(
      "completion is reported back to your chat automatically",
    );
    expect(flat).toContain("prefer ending your turn over waiting");
  });

  it("states the deliverable-extraction laws", () => {
    // Observed live: a lead looped for minutes unable to pull four ~2.4k-char
    // deliverables out of completed helpers — every tool relay truncated the
    // text, and messages to the completed helpers were dropped after
    // reporting success. Each pin below is one leg of the way out; drop any
    // leg and leads re-enter the retry loop.
    const flat = SWARM_PROMPT_OVERRIDE.replace(/\s+/g, " ");
    expect(flat).toContain("name an exact file path");
    expect(flat).toContain("full text, never a summary");
    expect(flat).toContain("Collect helpers ONE at a time");
    expect(flat).toContain("Never message a helper that has already completed");
    expect(flat).toContain("verified in hand");
    expect(flat).toContain("a stopped helper is gone for good");
  });
});

describe("the wake honesty line", () => {
  it("tells the truth about runtime-requested wakes — honored as platform wakes, never banned as invisible", () => {
    // Under external wake ownership the old ban ("wake-ups raised outside
    // the platform run invisibly") is FALSE — a runtime wake surfaces as a
    // platform watch. MUTATION-PROOF both ways: reintroduce the ban or drop
    // the honoring sentence and this fails.
    const flat = PLATFORM_SYSTEM_PROMPT.replace(/\s+/g, " ");
    expect(flat).toContain(
      "a wake requested through your runtime's own options is honored the same way",
    );
    expect(flat).not.toContain("run invisibly");
  });
});

describe("the turn-ending contract", () => {
  // The report-back incident's lesson: every line about watches was
  // conditioned on "a background task", and nothing told the agent that a
  // promise without an armed watch cannot be kept. These pins keep the
  // contract in the prompt — remove any leg and a live agent goes back to
  // "I'll check the result and report back" followed by silence.
  it("states that nothing runs between turns", () => {
    expect(PLATFORM_SYSTEM_PROMPT).toContain("Nothing runs between your turns");
  });

  it("forbids report-back promises without an armed wake", () => {
    const flat = PLATFORM_SYSTEM_PROMPT.replace(/\s+/g, " ");
    expect(flat).toContain(
      "Never end a turn promising to check on something or report back",
    );
    expect(flat).toContain("FIRST armed what will wake you");
  });

  it("bridges external systems to a watched poller", () => {
    const flat = PLATFORM_SYSTEM_PROMPT.replace(/\s+/g, " ");
    expect(flat).toContain("follow something outside this machine");
    expect(flat).toContain(
      "start a background poller with process_start and arm a process_watch",
    );
  });

  it("the processes fragment carries the same law", () => {
    const flat = processesFragment.body.replace(/\s+/g, " ");
    expect(flat).toContain("Nothing runs between your turns");
    expect(flat).toContain(
      'A promise to "report back" is only real after you arm the watch',
    );
  });
});

// The response-style contract (user decision, 2026-08-30): live agents were
// answering with multi-screen process narration nobody could read in chat.
// The weak "be concise" line demonstrably did not land, so the directive now
// SPECIFIES the behavior — outcome first, a few short lines, no narration,
// detail behind demand. These pins keep the legs that made the difference;
// the operator's brief still wins on conflict (the identity section's law).
describe("the response-style contract", () => {
  it("leads with the outcome", () => {
    const flat = PLATFORM_SYSTEM_PROMPT.replace(/\s+/g, " ");
    expect(flat).toContain(
      "lead with the outcome in the first one or two sentences",
    );
  });

  it("bans process narration and internal checklists", () => {
    const flat = PLATFORM_SYSTEM_PROMPT.replace(/\s+/g, " ");
    expect(flat).toContain("Do not narrate your process");
    expect(flat).toContain(
      "never include your internal checklists or step-by-step commentary",
    );
  });

  it("puts detail behind demand instead of inline", () => {
    const flat = PLATFORM_SYSTEM_PROMPT.replace(/\s+/g, " ");
    expect(flat).toContain("Detail belongs behind demand");
    expect(flat).toContain("expand only when asked");
  });
});

describe("the swarm-helper visibility contract", () => {
  // Helpers are mirrored as observed background processes (jcode-swarm.ts);
  // these pins keep the agent's world-model matching that machinery — drop
  // either leg and the model either busy-waits on long helpers or never
  // learns process_status covers them.
  it("tells the agent helpers are visible as observed processes", () => {
    const flat = SWARM_LIGHT_PROMPT.replace(/\s+/g, " ");
    expect(flat).toContain(
      "Helpers also appear as observed background processes",
    );
    expect(flat).toContain("process_status shows a helper's state");
  });

  it("prefers ending the turn over busy-waiting on a long helper", () => {
    const flat = SWARM_LIGHT_PROMPT.replace(/\s+/g, " ");
    expect(flat).toContain(
      "A turn that ends while helpers are still running gets their completion reported back automatically",
    );
    expect(flat).toContain(
      "prefer ending your turn over busy-waiting on a long helper",
    );
  });
});
