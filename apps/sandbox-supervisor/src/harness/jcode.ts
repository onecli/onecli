import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bundledJcodeBinary,
  JcodeClient,
  launchInstance,
  type ApiEvent,
} from "@1jehuang/jcode-sdk";
import {
  TURN_FAILURE_CODES,
  type AgentEffort,
  type AgentEvent,
  type Harness,
  type HarnessSession,
  type StartSessionOptions,
  type SteerInput,
  type TurnInput,
  type TurnUsage,
} from "@onecli/agent-protocol";
import { log } from "../log";
import { platformToolsSocketPath } from "../platform-tools";
import { writeManagedFile } from "../home/fs";
import { mergeBackgroundTasks } from "./background-merge";
import { createJcodeBackgroundTasks } from "./jcode-background";
import { forwardJcodeStderr, startJcodeLogForwarder } from "./jcode-log";
import { createJcodeSwarmTasks } from "./jcode-swarm";
import { healJcodeTranscripts } from "./jcode-transcript-heal";
import { createJcodeWakeFeed } from "./jcode-wake";

/**
 * The jcode adapter — the anti-corruption layer of §3.5. Everything
 * vendor-specific lives in THIS file: the SDK calls, the event-name mapping,
 * the config/env switches. Nothing above it may branch on "jcode"
 * (invariant 9).
 *
 * Every switch below was verified against jcode v0.71.x source and
 * re-verified against v0.78.1 (2026-08-19) and v0.81.1 (2026-08-26) at the pin bumps
 * (see plans/hosted-agents-v2.md §3.2/§3.5):
 * - `inheritLogins: false` — never import host provider logins (zero-cred).
 * - `JCODE_NO_TELEMETRY=1` — telemetry is on by default upstream.
 * - `JCODE_NO_AUTO_UPDATE=1` — the updater is on by default upstream, checks
 *   on EVERY process start, and on a headless process `exec()`s into the new
 *   binary mid-run, killing our socket. See resolveJcodeBinary /
 *   cleanJcodeUpdaterState for the other two thirds of the pin.
 * - `JCODE_DISABLED_TOOLS` (JCODE_DISABLED_TOOLS_VALUE below) — two laws in
 *   one list. `schedule,skill_manage` is §3.7: platform capabilities never
 *   go through harness-native duplicates. `gmail,integration_tools` is §3.2:
 *   zero credentials in the sandbox — the native gmail tool answers with its
 *   own OAuth/Composio setup flows, and the sponsor catalog's description
 *   tells the model to consult it "before using any product, service … or
 *   API", so both actively steer work around the governed gateway (observed
 *   live: an email request burned a turn on `jcode login google`, Composio
 *   env hints, and catalog recommendations before one gateway curl answered).
 *   `maintainer_feedback,jcode_docs` joined at the v0.78.1 bump — upstream
 *   registers both unconditionally (v0.77/v0.74) and neither is a reflex
 *   tool: `jcode_docs` serves compiled-in vendor documentation ("Use this
 *   first for questions about Jcode features"), a standing leak of the
 *   vendor identity PLATFORM_SYSTEM_PROMPT conceals; `maintainer_feedback`
 *   ships model-authored feedback to the vendor over telemetry — a no-op
 *   under JCODE_NO_TELEMETRY=1, but its name, description, and refusal
 *   reply all speak as the vendor.
 *   `browser` joined 2026-09-09 (plans/agent-owns-its-machine.md Tier 1):
 *   the native tool is a Firefox-extension bridge (an .xpi plus a
 *   native-messaging host) that can never work in a headless guest, and
 *   its own description tells the model to "check status first, run setup
 *   if not ready" — observed live burning a whole turn on setup attempts
 *   before declaring browsing impossible. The agent image bakes chromium
 *   instead (docker/agent.Dockerfile); Playwright/Puppeteer from npm or pip
 *   drive it, and the machine fragment says so.
 *   ⛔ Never add the literal name `mcp` to this list: since v0.75 it is a
 *   meta-entry covering every dynamic `mcp__*` tool, so it would silently
 *   kill the platform-tools bridge.
 *   Disabling is safe because a disabled tool is REMOVED from the
 *   model-visible tool list (upstream filters definitions; its own test
 *   proves it for gmail). The `bg` background tool is deliberately NOT
 *   disabled: a call to a disabled tool's exact name is turn-fatal upstream
 *   (no fallback — proven live), and background work is the harness's
 *   strongest reflex; the platform observes those tasks instead
 *   (`backgroundTasks` below; format contract in jcode-background.ts).
 *   `webfetch`/`websearch`/`bash` stay — their traffic rides the gateway
 *   proxy like everything else. `memory` joined the list with the memory
 *   write-back amendment (§3.8): `[features] memory=false` alone disables
 *   only the auto-recall/extraction machinery — the native tool registers
 *   unconditionally (verified in v0.71.1, still true through v0.81.1) and would write durable,
 *   platform-invisible JSON graphs; the platform's memory/ files and
 *   memory_* tools are the ONLY memory. Its state is purged per boot too
 *   (cleanJcodeKnowledgeStores).
 * - `[features] memory=false` — same rule for the big systems. `swarm=true`
 *   is the ONE deliberately-on subsystem: hosted agents always get bounded
 *   sub-agent fan-out, fenced by the JCODE_SWARM_ENV launch pins (worker cap
 *   + headless spawns; env beats the agent-writable config.toml on every
 *   reload) and by the harness's own root-only spawn rule — recursion needs
 *   the "swarm-deep" effort sentinel on the ROOT session, which the platform
 *   never grants (JCODE_EFFORT maps only low|medium|high|max).
 *   `check_updates=false` (a v0.76+ key, default TRUE) is the config half of
 *   the update pin: it gates the startup update-check thread alongside
 *   JCODE_NO_AUTO_UPDATE, so the pin no longer rests on the env var alone.
 * - `[sponsors] enabled=false` — the config half of the integration_tools
 *   kill: it stops the tool from ever REGISTERING and blocks all contact
 *   with the vendor's discovery endpoint (the env entry only filters the
 *   advertised list). See the trap note on managedConfigToml.
 * - `[provider] stream_idle_timeout_secs=300` — invariant 4: must exceed the
 *   gateway's 180 s approval hold (jcode's default is exactly 180).
 * - `[auth] trusted_external_sources` — jcode's consent gate for reading
 *   `CLAUDE_CODE_OAUTH_TOKEN`; pre-trusted because we own this home.
 */

const JCODE_HOME_DIRNAME = ".jcode-home";

/**
 * The agent's POSIX home under the workspace volume — byte-equal with the
 * agent image's contract (docker/agent-entrypoint.sh's export,
 * agent.Dockerfile `usermod -d`, AGENT_POSIX_HOME). Derived from homeDir, NEVER from
 * process.env.HOME: in local dev that is the developer's real home, and the
 * purge lists below DELETE from it.
 */
const POSIX_HOME_DIRNAME = ".home";

/**
 * Resolve THE jcode binary — pinned, never guessed.
 *
 * The agent image vendors an exact, checksum-verified release and names it
 * here (`ONECLI_JCODE_BINARY`); outside the image (local dev) the SDK's
 * npm-bundled platform binary is the fallback. What is deliberately NOT
 * allowed is the SDK's own last resort — bare `"jcode"` on PATH — because a
 * path miss would silently run whatever is lying around instead of the
 * version this adapter was verified against. A missing binary is a loud
 * boot failure, not a fallback.
 */
export const resolveJcodeBinary = (): string => {
  const pinned = process.env.ONECLI_JCODE_BINARY;
  if (pinned) {
    if (!existsSync(pinned)) {
      throw new Error(
        `ONECLI_JCODE_BINARY points at a missing file: ${pinned}`,
      );
    }
    return pinned;
  }
  const bundled = bundledJcodeBinary();
  if (!bundled || !existsSync(bundled)) {
    throw new Error(
      "No jcode runtime: set ONECLI_JCODE_BINARY or install the SDK's platform package",
    );
  }
  return bundled;
};

/**
 * Remove the self-updater's on-disk state from a (persistent) jcode home.
 *
 * `JCODE_NO_AUTO_UPDATE` stops checks, downloads, and the mid-run exec — but
 * it does NOT gate binary RESOLUTION: jcode's daemon prefers
 * `builds/shared-server` → `builds/stable` over the spawned file (verified in
 * v0.71.1 and re-verified through v0.81.1: `dispatch.rs` spawn_server → `paths.rs`
 * shared_server_update_candidate, no env check). A volume that self-updated
 * before the pin would therefore keep booting its downloaded daemon under our
 * pinned client — a bridge/daemon version split upstream itself documents as
 * incompatible. Deleting `builds/` + `bin/` (the updater's symlink dir) makes
 * the spawned binary the only one that can run; with the env var set, nothing
 * ever repopulates them (live-verified: the daemon re-mkdirs an EMPTY
 * `builds/` as directory skeleton, and resolution then falls through to the
 * spawned binary). `update_metadata.json` goes too — it is updater state
 * (last check, install provenance) that would otherwise read as if updates
 * were live.
 *
 * `provider-backends/` joined at the v0.78.1 bump: it is the volume's other
 * EXECUTABLE stash — jcode prefers a managed CLI at
 * `provider-backends/grok-build/grok` and execs it when that provider is
 * selected — and the same law applies: nothing on the agent-writable volume
 * may be something jcode will execute.
 *
 * `browser/` joined with the browser-tool disable (2026-09-09): it is the
 * volume's third executable stash — `jcode browser setup` downloads the
 * Firefox bridge's native-messaging host and a helper binary there, and the
 * tool execs them. The tool is disabled (JCODE_DISABLED_TOOLS_VALUE), so
 * nothing repopulates it; a stash a pre-disable session left behind, or an
 * agent runs the setup subcommand into, is gone at the next boot.
 *
 * Symlink-safe by the same law as the home materializer: `rmSync`
 * unlinks a link rather than following it, so an agent planting
 * `builds -> /somewhere` costs the link, never the target.
 */
export const cleanJcodeUpdaterState = (jcodeHome: string): void => {
  for (const entry of [
    "builds",
    "bin",
    "update_metadata.json",
    "provider-backends",
    "browser",
  ]) {
    rmSync(join(jcodeHome, entry), { recursive: true, force: true });
  }
};

/**
 * Purge the harness's OWN knowledge stores, every boot (§3.7: platform
 * capabilities never go through harness-native equivalents; the memory
 * amendment made this airtight). Two families:
 *
 *  - native memory/notes JSON graphs: `[features] memory=false` disables the
 *    auto-recall machinery but NOT the `memory` tool (verified in v0.71.1,
 *    still true in v0.81.1 — the tool registers unconditionally), so the tool
 *    is disabled via JCODE_DISABLED_TOOLS below and any state it ever wrote
 *    is deleted;
 *  - unmanaged skill-stash dirs jcode loads on existence (home
 *    `.jcode/skills`, `.claude/skills`, `$JCODE_HOME/skills`,
 *    `external/.agents/skills`): a skill written there by file tools would
 *    load next session, invisible to the platform. The managed skills root
 *    (`.agents/skills`) is NOT touched — the sync channel owns it.
 *    The `external/` trio joined at the v0.78.1 bump: with JCODE_HOME set,
 *    jcode resolves user-home paths under `$JCODE_HOME/external/`, and its
 *    first-run import copies `external/.claude/skills` +
 *    `external/.codex/skills` into the live registry whenever
 *    `$JCODE_HOME/skills` is absent — which THIS purge guarantees every
 *    boot — while `external/.claude/plugins` is a global skill source
 *    scanned on existence. All three live on the agent-writable volume, so
 *    a planted stash would re-enter the registry at the next boot without
 *    this purge (a pre-existing gap, closed at the bump).
 *
 * Same product-law posture as the prompt/MCP overrides: the agent can
 * rewrite mid-session; the next boot heals. `rmSync` unlinks a planted link
 * rather than following it (the standing symlink law).
 */
export const cleanJcodeKnowledgeStores = (
  homeDir: string,
  jcodeHome: string,
): void => {
  // The durable POSIX home (~ = <homeDir>/.home) is the raw-$HOME twin of
  // the external/ sandbox: $HOME used to be ephemeral rootfs (self-healing
  // by relaunch), but it now persists on the volume, so every user-home
  // stash path jcode's resolver knows must join the per-boot purge or a
  // planted skill would re-enter the registry durably. The managed skills
  // root stays <homeDir>/.agents/skills — a different path, untouched.
  const posixHome = join(homeDir, POSIX_HOME_DIRNAME);
  for (const path of [
    join(jcodeHome, "memory"),
    join(jcodeHome, "notes"),
    join(jcodeHome, "skills"),
    join(jcodeHome, "external", ".agents", "skills"),
    join(jcodeHome, "external", ".claude", "skills"),
    join(jcodeHome, "external", ".claude", "plugins"),
    join(jcodeHome, "external", ".codex", "skills"),
    join(homeDir, ".jcode", "skills"),
    join(homeDir, ".claude", "skills"),
    join(posixHome, ".agents", "skills"),
    join(posixHome, ".jcode", "skills"),
    join(posixHome, ".claude", "skills"),
    join(posixHome, ".claude", "plugins"),
    join(posixHome, ".codex", "skills"),
  ]) {
    rmSync(path, { recursive: true, force: true });
  }
};

// writeManagedFile moved to home/fs.ts (step 9): the materializer and
// this adapter share one symlink-hardened write — the law lives there.

/**
 * TRAP (verified in v0.71.1, re-verified unchanged through v0.81.1): the
 * `[sponsors]` section must stay exactly `enabled = false` with NO
 * `endpoint` key. The harness "repairs" a
 * section holding enabled=false PLUS its default endpoint back to enabled —
 * it reads that shape as machine-written — while a bare hand-written
 * `enabled = false` is respected. The harness's own config save would
 * round-trip the file into the repaired shape — its saves serialize both
 * keys unconditionally — which is why this file is rewritten at every
 * container boot (once, before the daemon instance launches; ensureInstance
 * memoizes after that) and why the env-level tool disable exists
 * as a second, independent lever that reapplies on every config load.
 */
export const managedConfigToml = `# Written by the OneCLI supervisor at every container boot — do not edit.
[features]
memory = false
swarm = true
check_updates = false

[provider]
stream_idle_timeout_secs = 300

[tools]
mcp_tools = "eager"

[auth]
trusted_external_sources = ["claude_code_native_credentials"]

[sponsors]
enabled = false
`;

/**
 * The platform-tool cliff fence. Since v0.79.1 the harness defaults
 * \`mcp_tools = "auto"\`: above an 8k-token threshold it silently REPLACES
 * every mcp__* tool definition with a generic search/call pair — which
 * would strip the platform tools (processes, watches, memory, schedules)
 * out of the model's tool list the day their combined definitions cross
 * the line (we sit near half of it today). Pinned eager in BOTH places:
 * the config statement above and this env fence (reload-fingerprinted
 * upstream, so it reapplies on every config load and an agent editing its
 * own config.toml cannot flip it back).
 */
export const JCODE_MCP_TOOLS_ENV_VALUE = "eager";

/**
 * Sub-agent fan-out is ALWAYS ON for hosted agents (a product decision:
 * every agent may parallelize, no per-agent switch). `swarm = true` above
 * turns the subsystem on; the SAFETY limits live in JCODE_SWARM_ENV below,
 * not in this file — this file sits on the agent-writable volume and the
 * harness hot-reloads it, so a value here is a statement, not a fence.
 */
export const SWARM_WORKER_CAP = 8;

/**
 * The launch-env half of the swarm posture — like JCODE_DISABLED_TOOLS,
 * this constant IS the env the launch call passes, exported so the pin
 * test asserts the exact strings the harness parses. Env overrides beat
 * config.toml on EVERY config load (verified in v0.78.1, unchanged in v0.81.1
 * `env_overrides.rs` / `config.rs`: both keys are in the reload
 * fingerprint), so an agent editing its own config.toml cannot raise the
 * cap — THIS is the hard stop, at the harness's spawn-admission gate.
 * `swarm_spawn_mode` pins the worker default to headless (upstream
 * defaults to `inline`, a TUI gallery mode nothing here renders); a
 * per-spawn override degrades gracefully in a windowless container.
 */
export const JCODE_SWARM_ENV = {
  JCODE_SWARM_MAX_CONCURRENT_AGENTS: String(SWARM_WORKER_CAP),
  JCODE_SWARM_SPAWN_MODE: "headless",
} as const;

/**
 * Provider-native web search (jcode v0.90.0, upstream #1620/#1622). The
 * local `websearch` tool scrapes DuckDuckGo/Bing from the sandbox, and
 * search engines CAPTCHA datacenter egress after a handful of requests
 * (observed in production: Google `/sorry` 429s and DuckDuckGo anomaly
 * challenges in the middle of a list-enrichment task). With prefer_native the request
 * carries Anthropic's server-side `web_search` tool instead, so searches
 * run on the provider's side and never leave the sandbox.
 * Upstream already defaults prefer_native to true; it is pinned here so the
 * posture survives an agent editing its own config.toml (env overrides are
 * reload-fingerprinted upstream, same mechanism as JCODE_SWARM_ENV).
 * The cap: upstream's default is 5 searches per request, which a single
 * list-enrichment turn exceeds immediately; past the cap the model gets a
 * `max_uses_exceeded` tool error and stops early. Searches on API-key
 * grants bill ~$10 per 1,000; OAuth grants draw on the plan's usage.
 * Native search is attached only when the session offers `websearch`, so
 * keep `websearch` OFF JCODE_DISABLED_TOOLS_VALUE.
 */
export const WEBSEARCH_NATIVE_MAX_USES = 25;

export const JCODE_WEBSEARCH_ENV = {
  JCODE_WEBSEARCH_PREFER_NATIVE: "1",
  JCODE_WEBSEARCH_NATIVE_MAX_USES: String(WEBSEARCH_NATIVE_MAX_USES),
} as const;

/**
 * Appended to the platform system prompt so the model uses the fan-out
 * well and stays inside the enforced envelope instead of slamming into
 * the harness's refusals. Discipline, not enforcement: the cap is
 * enforced by JCODE_SWARM_ENV above, recursion is refused by the harness
 * itself (worker spawns are root-only), and the effort sentinels the
 * prompt bans are never granted by the platform (see JCODE_EFFORT).
 * Also carries the compact deliverable-extraction laws (files for long
 * deliverables, one-at-a-time collection, no messages after completion,
 * verify before stopping) — the full statement and its rationale live in
 * SWARM_PROMPT_OVERRIDE below.
 * Kept as one block so the pin test can assert it.
 */
export const SWARM_LIGHT_PROMPT = `

## Sub-agents

You may parallelize work by spawning helper agents (your swarm tool, light
fan-out): give each helper ONE self-contained task and a fresh context, let
it report back, and integrate the results yourself.
Rules: at most ${SWARM_WORKER_CAP} helpers alive at once; helpers never
spawn their own helpers; spawn headless only; prefer doing small tasks
yourself — helpers are for genuinely parallel or context-heavy work.
Never pass "swarm" or "swarm-deep" as an effort, and never use the task
graph's deep mode — flat one-level fan-out is the only supported shape.
If a spawn or swarm call is refused right after your computer starts,
retry once before concluding the tooling is unavailable — membership can
take a moment to settle.
Every relay of helper text truncates long content: in each helper's task
prompt, name an exact file path for any deliverable longer than a
paragraph and have the helper write the complete deliverable there and
end its reply with it. Collect finished helpers one at a time, and never
message a helper that has already completed — such messages report
success yet are silently dropped.
After a helper's deliverable is verified in hand, stop or clean up that
helper — idle helpers hold memory for nothing.
Helpers also appear as observed background processes: process_status shows
a helper's state and its final report, and watches can cover it. A turn
that ends while helpers are still running gets their completion reported
back automatically — prefer ending your turn over busy-waiting on a long
helper.`;

/**
 * THE SWARM TOOL'S PROMPT SLOT — replaces the harness's built-in swarm
 * routing guidance, which the fan-out tool embeds in its own model-visible
 * description. Owned for the same reason as system-prompt.md: the built-in
 * text is the vendor's voice (and at the pinned version it is self-
 * contradictory — it advises passing a per-spawn model that the tool schema
 * no longer accepts, naming vendor models unavailable here). Worker models
 * are operator-controlled at this version, so the honest guidance is
 * structure only. The collection laws below encode measured behavior at
 * the pinned version: every relay of helper text truncates long content
 * (transcript reads cap each message, a multi-helper await caps the whole
 * result), a message to a completed helper is dropped after reporting
 * success, and a stopped helper is unrecoverable — so a named file is the
 * only whole-fidelity deliverable channel, and stops must come after
 * collection. Written to BOTH resolution slots (project + home) with
 * the same heal-at-boot law as the system prompt; the identity rule
 * applies — no vendor or model names in these bytes.
 */
export const SWARM_PROMPT_OVERRIDE = `Guidance for spawning helper agents.

- Worker models are chosen by the platform. There is no per-helper model
  choice — never try to set one.
- Always pass a short label when spawning (for example "api reviewer") so
  each helper's purpose is visible.
- Only the root session spawns helpers; helpers complete their one task and
  report back, never spawning their own.
- A helper's FINAL REPLY is the only report you receive, and every relay
  of helper text truncates long content. So in each helper's task prompt,
  name an exact file path for any deliverable longer than a paragraph and
  tell the helper to write the complete deliverable there, then end its
  reply with the complete deliverable too (full text, never a summary of
  it). Collect a long deliverable by reading its file — transcript reads
  truncate and cannot recover what a reply left out.
- Collect helpers ONE at a time: an await over several helpers truncates
  their replies to fit one shared result; a helper awaited alone gets the
  whole result to itself.
- Never message a helper that has already completed: delivery reports
  success, but nothing is listening and the message is silently dropped.
  Messages reach a helper only while its turn is still running.
- Read helper status and reports with process_status. Helpers are NOT
  background tasks: the bg tool cannot see them and cannot wait for them.
- The platform tracks helpers on its own: their completion is reported
  back to your chat automatically, so prefer ending your turn over waiting
  in it. To wait in-turn anyway, use this tool's own await action — one
  call, no polling.
- Stop a helper only after its deliverable is verified in hand (the file
  read, or the full text in your context) — a stopped helper is gone for
  good. Then do stop it: idle helpers hold memory for nothing.`;

/**
 * The harness-native tools the platform turns off, exported so the pin test
 * asserts the exact string the launch env actually reads (a drifted copy
 * would pin nothing). Rationale per entry lives in the adapter header above.
 */
export const JCODE_DISABLED_TOOLS_VALUE =
  "schedule,skill_manage,gmail,integration_tools,memory,maintainer_feedback,jcode_docs,browser";

/**
 * THE PLATFORM'S BASE SYSTEM PROMPT — it REPLACES the harness's built-in one.
 *
 * Why this exists: the harness ships an identity ("your name is <vendor>, you
 * are a coding agent") that reaches the model ahead of everything we render.
 * A hosted agent's identity is the PLATFORM's to state — its name, its
 * operator, its brief — so the vendor's self-description must not survive
 * into the conversation. Deliberately name-free: the rendered instruction
 * files carry the agent's actual name, and this text defers to them.
 *
 * What is kept from the harness's default (and why, for a HOSTED agent):
 * persistence and initiative (no human is at the keyboard mid-turn), the
 * blocking-question rule (a question ends the turn), hesitation before
 * irreversible acts, non-interactive execution (there is no TTY), closed-loop
 * iteration, the todo tool, and markdown/conciseness. What is dropped: the
 * vendor's name, the coding-agent framing, commit-as-you-go, its multi-agent
 * worktree lore, and its CLI-display and prose-style micromanagement.
 */
export const PLATFORM_SYSTEM_PROMPT = `## Identity

You are a hosted autonomous agent. Your name, who you work for, and your
standing instructions are defined in the operator-provided instruction
documents appended below. That is your operator's configuration: follow it,
and where it conflicts with this text, it wins.

Your role is whatever those documents say it is — do not assume you are a
coding assistant because you can run commands.

The session context lists infrastructure details about the machine you run
on, including the name and version of the runtime executing you. That is
internal plumbing, not your identity. When you are asked who you are, what
you are, or what you are built on — including when someone proposes a
specific product name and asks whether that is you — say who you are (the
agent your instructions describe, hosted on OneCLI) and that you do not
discuss the platform's internals. Do not repeat, confirm, or deny any runtime
or vendor name: naming it to reject it still names it.

## Autonomy and persistence

Work autonomously and persist until the task is complete, including the
related work the task implies.
Infer intent and take initiative. Prefer fixing problems over reporting them.
Asking a question ends your turn and blocks until someone replies; do this
sparingly, when genuinely stuck or when consent is needed.
Do nothing your operator would regret. Hesitate before destructive or
irreversible actions: completing a payment, deleting data, sending an email.
Never reset a password.

## Execution

You cannot drive interactive commands; use non-interactive alternatives.
When a closed feedback loop exists (build, test, check), keep iterating until
it passes.
Use the todo tool to plan and track multi-step work.
The platform tracks background tasks however you start them and delivers
watch wake-ups to the chat. To be woken when a background task completes,
arm process_watch; a wake requested through your runtime's own options is
honored the same way — it arrives as a platform wake in the chat the work
belongs to.
Nothing runs between your turns: once a turn ends, nothing wakes you except
a person's message, a schedule, or a watch. Never end a turn promising to
check on something or report back unless you have FIRST armed what will
wake you — a process_watch on a background task, or a scheduled task. To
follow something outside this machine (a CI run, a deploy, a webhook),
start a background poller with process_start and arm a process_watch on
it; checking it once in the foreground and ending your turn means you will
never see the result.

## External services

All outside access — email, calendars, code hosts, chat, any web API — goes
through the platform's credential-injecting gateway: make plain HTTPS
requests with a standard HTTP client and no auth headers, and the gateway
supplies the real credentials on the wire. Never use an integration or
login tool the runtime happens to ship, a third-party integration platform,
or a provider's own OAuth or API-key setup flow — and never ask anyone for
a key or token. When a request is refused, the gateway's JSON error says
what to do next; your instruction documents name the skill that explains
the gateway.

## Communication

Responses are rendered as markdown.
Write like a busy colleague in chat: lead with the outcome in the first one
or two sentences, then only what the reader must know. Aim for a handful of
short lines; use a list only when items genuinely differ, and a heading only
in a long reference answer someone asked for.
Do not narrate your process, restate the request, or pad with caveats, and
never include your internal checklists or step-by-step commentary.
Detail belongs behind demand: say where the full story lives (a file, a PR,
a log) instead of inlining it, and expand only when asked or when your brief
asks for detail.
Only your FINAL message — what you write after your last tool call — is
delivered as your reply; text written before a tool call streams as
progress and is then discarded. Never bury an answer before a tool call:
make the final message complete on its own, restating whatever the person
still needs even if you said it mid-turn.
`;

/**
 * Take ownership of every prompt slot the harness reads, at every boot.
 *
 * The harness resolves its base prompt as: project `<home>/.jcode/
 * system-prompt.md` → global `$JCODE_HOME/system-prompt.md` → its built-in
 * default. BOTH replacement slots must be ours: the project slot wins
 * precedence and — because the home is the durable volume — an agent
 * that plants one would keep it across reboots; and an EMPTY file falls
 * through rather than replacing, so leaving either slot unwritten re-exposes
 * the vendor identity.
 *
 * The additive hooks (prompt overlay, preferred tools, the home's global
 * instruction file) are DELETED rather than emptied: the harness includes
 * them on existence alone, so an empty file is prompt noise with no benefit.
 *
 * This is product law, not a security boundary. The agent owns these
 * directories and can rewrite a slot mid-session (it takes effect on its next
 * turn); the next boot heals it. The real controls — credentials, egress,
 * approvals — are the gateway's, and none of them depend on this text.
 */
export const preparePromptFiles = (
  homeDir: string,
  jcodeHome: string,
): void => {
  const projectPromptDir = join(homeDir, ".jcode");
  mkdirSync(projectPromptDir, { recursive: true });

  // Fan-out is always on, so the swarm discipline block is part of the base
  // prompt — both slots, same bytes, like everything else here.
  const systemPrompt = PLATFORM_SYSTEM_PROMPT + SWARM_LIGHT_PROMPT;
  writeManagedFile(join(jcodeHome, "system-prompt.md"), systemPrompt, 0o444);
  writeManagedFile(
    join(projectPromptDir, "system-prompt.md"),
    systemPrompt,
    0o444,
  );

  // The swarm tool's own prompt slot — same two-slot, same-bytes law. The
  // PROJECT slot resolves against the daemon's working directory (which is
  // this home), so it covers every session; the home slot is the fall-
  // through that keeps us covered if that resolution ever changes.
  writeManagedFile(
    join(jcodeHome, "swarm-prompt.md"),
    SWARM_PROMPT_OVERRIDE,
    0o444,
  );
  writeManagedFile(
    join(projectPromptDir, "swarm-prompt.md"),
    SWARM_PROMPT_OVERRIDE,
    0o444,
  );

  // No POSIX-home ($HOME = <homeDir>/.home) entries here, deliberately: the
  // prompt chain is project <workingDir>/.jcode → global $JCODE_HOME →
  // built-in, and the home-global instruction slot is external/AGENTS.md
  // (deleted above) — raw $HOME appears nowhere in it.
  for (const path of [
    join(projectPromptDir, "prompt-overlay.md"),
    join(jcodeHome, "prompt-overlay.md"),
    join(projectPromptDir, "preferred-tools.md"),
    join(jcodeHome, "preferred-tools.md"),
    join(jcodeHome, "external", "AGENTS.md"),
  ]) {
    rmSync(path, { force: true });
  }
};

/** The platform-tools MCP bridge, resolved from THIS module so the path is
 * right wherever the supervisor runs from. Two layouts exist: the esbuild
 * bundle (dist/index.mjs with the bridge copied to dist/mcp-bridge/ — a
 * sibling, "./"), and the tsx dev loop (this file under src/harness/ with the
 * bridge one level up, "../"). The bridge is spawned as a separate process,
 * so no import graph pins it — resolve by existence and refuse to guess. */
export const resolveMcpBridgePath = (moduleUrl: string): string => {
  const candidates = [
    "./mcp-bridge/bridge.mjs",
    "../mcp-bridge/bridge.mjs",
  ].map((rel) => fileURLToPath(new URL(rel, moduleUrl)));
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      `mcp-bridge/bridge.mjs not found at ${candidates.join(" or ")}`,
    );
  }
  return found;
};

const MCP_BRIDGE_PATH = resolveMcpBridgePath(import.meta.url);

/**
 * Take ownership of the harness's MCP config, every boot (step 7).
 *
 * jcode reads MCP servers from JSON files, stdio transport only, and merges
 * PROJECT-local files over the global one — so like the prompt slots, owning
 * just our own file is not enough: the agent-writable overrides (home
 * `.jcode/mcp.json`, `.mcp.json`, `.claude/mcp.json`, and the Claude-compat
 * files jcode sandboxes into `$JCODE_HOME/external/`) are deleted per boot,
 * or a planted entry would add servers — or shadow ours by name — for the
 * container's whole life. Same product-law posture as the prompt files.
 *
 * `shared: false`, deliberately: jcode's shared pool snapshots config once
 * per PROCESS, which is the source of its mid-session staleness bugs; an
 * owned per-session client re-reads per session. One container serves one
 * agent — pooling buys nothing and costs correctness.
 *
 * The command is `process.execPath` (the exact node binary running this
 * supervisor) + the bridge's absolute path: no PATH lookup, no tsx, nothing
 * the agent's environment can redirect.
 */
export const prepareMcpConfig = (
  homeDir: string,
  jcodeHome: string,
  socketPath: string,
): void => {
  const config = {
    mcpServers: {
      onecli: {
        command: process.execPath,
        args: [MCP_BRIDGE_PATH],
        env: { ONECLI_TOOLS_SOCKET: socketPath },
        shared: false,
      },
    },
  };
  writeManagedFile(
    join(jcodeHome, "mcp.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    0o600,
  );

  // The durable ~ (<homeDir>/.home) mirrors the same override surface —
  // see cleanJcodeKnowledgeStores for why the POSIX home joined the purge.
  const posixHome = join(homeDir, POSIX_HOME_DIRNAME);
  for (const path of [
    join(homeDir, ".jcode", "mcp.json"),
    join(homeDir, ".mcp.json"),
    join(homeDir, ".claude", "mcp.json"),
    join(jcodeHome, "external", ".claude.json"),
    join(jcodeHome, "external", ".claude", "mcp.json"),
    join(posixHome, ".jcode", "mcp.json"),
    join(posixHome, ".mcp.json"),
    join(posixHome, ".claude", "mcp.json"),
    join(posixHome, ".claude.json"),
  ]) {
    rmSync(path, { force: true });
  }
};

/**
 * Apply the agent's model and effort, returning notices for anything the
 * harness would not take.
 *
 * THE MODEL IS A PREFERENCE; THE TURN IS THE PRODUCT. An id jcode does not
 * recognize must not fail the session: it is baked into the container's env for
 * that container's whole life, and `runtime.session` is only cached after this
 * resolves — so a throw here means every turn in every conversation fails
 * identically, forever, with the container still reporting healthy. Degrading
 * to the harness's own default and saying so once is the difference between a
 * wrong dropdown value and a bricked agent.
 *
 * A transport fault still throws — but note what that costs: the caller
 * detaches and rethrows, which fails THIS turn and leaves the container
 * advertised as healthy. It is only recycled if the SDK independently raises
 * `close`, which a genuinely dead socket does. That is the intended split:
 * refusals degrade, a dead channel is the failure signal this adapter already
 * owns.
 */
const applyPreferences = async (
  jcode: JcodeClient,
  sessionId: string,
  options: StartSessionOptions,
): Promise<string[]> => {
  const notices: string[] = [];

  if (options.model) {
    const target = toJcodeModel(options.model);
    try {
      await jcode.setModel(sessionId, target);
    } catch (error) {
      // A timeout is not an answer: the daemon defers control ops behind a
      // busy agent lock and replies only when the turn ends. Keep the default
      // silently — a slow control op must neither fail the turn nor tell the
      // user their model "isn't available" (both happened live).
      if (errorCode(error) === "timeout") {
        log("warn", "model preference timed out; keeping the default", {
          model: target,
        });
      } else if (isHarnessRefusal(error)) {
        log("warn", "harness rejected the configured model", {
          model: target,
        });
        notices.push(
          `The model ${options.model} isn't available here, so this agent is running its default instead. Pick another in the agent's Models section.`,
        );
      } else {
        throw error;
      }
    }
  }

  if (options.effort) {
    try {
      await jcode.setReasoningEffort(sessionId, JCODE_EFFORT[options.effort]);
    } catch (error) {
      if (errorCode(error) === "timeout") {
        log("warn", "effort preference timed out; keeping the default", {
          effort: options.effort,
        });
      } else if (isHarnessRefusal(error)) {
        log("warn", "harness rejected the configured effort", {
          effort: options.effort,
        });
        notices.push(
          `This model doesn't support the "${options.effort}" thinking level, so it's running at its default.`,
        );
      } else {
        throw error;
      }
    }
  }

  return notices;
};

const usageFromEvent = (
  event: Extract<ApiEvent, { ev: "token_usage" }>,
): TurnUsage => ({
  inputTokens: event.input,
  outputTokens: event.output,
  ...(event.cache_read_input !== undefined
    ? { cacheReadInputTokens: event.cache_read_input }
    : {}),
});

/**
 * OUR model id → jcode's.
 *
 * The control plane speaks the PROVIDER's vocabulary (`claude-sonnet-4-6`) and
 * knows nothing about which harness will run the agent — translating is this
 * adapter's job, and this table is where jcode's spelling quirks belong. It is
 * near-empty today because jcode accepts the providers' own ids for the models
 * we offer; it exists so the day one diverges is a one-line edit here rather
 * than vendor knowledge leaking upward. An id with no entry is passed through,
 * and a pass-through jcode rejects degrades (below) rather than failing.
 */
const JCODE_MODEL_ALIASES: Record<string, string> = {};

const toJcodeModel = (model: string): string =>
  JCODE_MODEL_ALIASES[model] ?? model;

/**
 * OUR effort scale → jcode's. jcode accepts
 * `none|minimal|low|medium|high|xhigh|max`, a superset of ours; the names we
 * share are a coincidence of vocabulary, not a contract, so the mapping is
 * written out rather than assumed.
 *
 * Exported for the pin test, which asserts something sharper than the
 * vocabulary: jcode also accepts the SENTINEL efforts `swarm` and
 * `swarm-deep`, and setting `swarm-deep` on the ROOT session is the one
 * unlock for recursive worker spawning. This map is the only place the
 * platform hands jcode an effort, so it staying sentinel-free IS the
 * no-recursion guarantee.
 */
export const JCODE_EFFORT: Record<AgentEffort, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  max: "max",
};

/**
 * Codes the SDK mints LOCALLY for channel and launch faults — never the daemon
 * answering. `timeout` is the load-bearing entry: a control op against a busy
 * session is deferred daemon-side on the agent lock and only answered when the
 * turn ends, so the SDK's 30s timeout fires with `code: "timeout"` — treating
 * that as "the harness refused this model" produced a false "isn't available
 * here" notice in production (the stuck-sandbox incident, reproduced live).
 * The rest are listed for completeness; only `timeout` and `disconnected` are
 * reachable from a request path.
 */
const SDK_LOCAL_CODES = new Set([
  "timeout",
  "disconnected",
  "connect_failed",
  "handshake_failed",
  "startup_failed",
  "startup_timeout",
  "jcode_not_found",
  "unsupported_transport",
  "invalid_option",
  "unexpected_reply",
  "event_buffer_overflow",
  "concurrent_next",
]);

/** The error's `code`, when it carries a string one. */
const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

/**
 * Did the harness ANSWER, refusing this preference — as opposed to the channel
 * dying under us or the request simply going unanswered?
 *
 * Broad on the daemon side deliberately. Keying on a single code
 * (`invalid_request`) was too narrow: the daemon's reply union is
 * `unsupported_version | unknown_request | unknown_session | invalid_request |
 * internal`, and it documents `invalid_request` only for `setModel`. A build
 * without `set_reasoning_effort` answers `unknown_request`, and a provider
 * refusing a level can surface as `internal` — either would have been rethrown,
 * which brings back exactly the brick this whole path exists to prevent: an
 * uncached session, so every turn in every conversation of that container fails
 * identically, forever, while it reports healthy.
 *
 * But an SDK-LOCAL code is not an answer: `timeout` means the daemon never
 * replied (deferred, not refused), and the transport codes mean the channel
 * died. Those must never mint a "this model isn't available" notice.
 */
const isHarnessRefusal = (error: unknown): boolean => {
  const code = errorCode(error);
  return code !== undefined && !SDK_LOCAL_CODES.has(code);
};

/**
 * Which pending steers actually made it into the run — the reconcile's pure
 * core, exported for its tests.
 *
 * jcode drains its soft-interrupt queue at a safe point, joins the grouped
 * texts with "\n\n", and appends them as ONE fresh user message (verified in
 * v0.71.1 `interrupts.rs`; byte-identical through v0.81.1). So each steer's text
 * always lands inside a
 * SINGLE history entry, and the match is per-entry substring, longest steer
 * first, consuming each matched span:
 *
 * - Per ENTRY, never a concatenated blob: joining candidates with "\n\n"
 *   would make entry boundaries indistinguishable from in-entry group
 *   separators, and a steer spanning two separately-injected entries would
 *   falsely settle `joined` — the message silently swallowed.
 * - Substring, not exact-part-equality: a steer whose own text contains
 *   "\n\n" would be split by any separator-based matcher and read as missed
 *   — promoting (and double-running) every multi-paragraph follow-up.
 * - Longest-first + span consumption: with steers "abc" and "a" both
 *   pending, "abc" claims its span before "a" can shadow it, and a span
 *   never confirms two steers.
 */
export const matchJoinedSteers = (
  pending: readonly SteerInput[],
  candidateContents: readonly string[],
): string[] => {
  const entries = [...candidateContents];
  const joined: string[] = [];
  for (const steer of [...pending].sort(
    (a, b) => b.message.length - a.message.length,
  )) {
    if (steer.message.length === 0) continue;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i] ?? "";
      const at = entry.indexOf(steer.message);
      if (at === -1) continue;
      joined.push(steer.id);
      entries[i] = entry.slice(0, at) + entry.slice(at + steer.message.length);
      break;
    }
  }
  return joined;
};

/**
 * Vendor wording of the daemon's send refusal while a run is in flight — the
 * self-heal trigger below. On a per-conversation connection the only run that
 * can hold the session is this conversation's own earlier, platform-abandoned
 * one, which is what makes cancelling it safe. Stays inside the adapter
 * (invariant 9 — the vendor's vocabulary never crosses this boundary).
 */
const BUSY_REFUSAL_SHAPE = /already processing a message/i;

/**
 * The daemon's cancel-path error wording. During the settle phase, after this
 * turn has cancelled an orphan, an error of this shape is the ORPHAN's residue
 * — never this turn's terminal. Only consulted there; in the live phase a
 * cancel-shaped error is a real terminal (a user abort ends exactly this way).
 */
const ORPHAN_CANCEL_SHAPE = /cancelled by user/i;

/**
 * How long after each send frames are held before being trusted as this
 * turn's own. A busy refusal lands in ~150ms (measured live); the first
 * genuine model delta takes longer than this window in practice, so in the
 * common no-orphan case the hold delays nothing observable.
 */
export const BUSY_DETECT_WINDOW_MS = 1_000;

/**
 * Backoff between self-heal resends, exported for the adapter tests. Bounded
 * on purpose: a session that stays busy through every cancel+resend is
 * wedged, and the turn must fail coded (`harness_busy`), canonical, and
 * visible — rather than loop forever. The supervisor's heartbeat runs the
 * whole time, so the turn stays alive and abortable while this waits.
 */
export const BUSY_RESEND_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000];

/** How long a heal round drains orphan residue before resending. */
const ORPHAN_DRAIN_MIN_MS = 250;

/** While the fence is pending the live loop wakes on this tick to honor an
 * abort (a foreign run may be holding the daemon's request loop, so no
 * cancel confirmation can arrive) and to keep the quarantine responsive. */
const BARRIER_TICK_MS = 250;

/**
 * The POST-ACCEPT liveness deadline (issue #1124). Once the daemon has
 * accepted our message, every frame of the turn rides this connection: the
 * model's deltas, tool events, the daemon's own 30 s keepalive `Pong`
 * during a silent think, and the terminal. Silence past this bound with no
 * tool call open means the ADAPTER's loop is waiting on a terminal that is
 * not coming — the shape that burned a 6 h ceiling three times live — and
 * the turn is failed coded (`harness_no_terminal`) instead of hanging.
 *
 * Above the harness's own provider idle timeout (`stream_idle_timeout_secs`
 * = 300 in the managed config) with one retry's headroom, deliberately: a
 * byte-dead provider stream is the harness's to fail, with its own more
 * specific error, and this clock must never pre-empt that. Exported for the
 * adapter tests, which shorten it.
 */
export const POST_ACCEPT_IDLE_MS = { value: 600_000 };

/**
 * How long after `abort()` the live loop waits for the daemon's terminal
 * before ending the turn itself. The daemon promises ≤ 2.5 s (a 500 ms
 * cooperative window, then a 2 s hard abort); four times that never races a
 * healthy cancel. A cancel that finds no task daemon-side (the turn already
 * ended and its terminal was lost — #1124 again) emits no terminal at all,
 * and without this bound Stop was visibly a no-op. Exported for the tests.
 */
export const ABORT_TERMINAL_GRACE_MS = { value: 10_000 };

/** Foreign-frame kinds worth counting when quarantined — the ones the live
 * loop would otherwise have surfaced or recorded. Everything else (acks,
 * status broadcasts) is dropped by the default arm even when trusted. */
const QUARANTINE_COUNTED = new Set([
  "text_delta",
  "reasoning_delta",
  "tool_start",
  "tool_done",
  "token_usage",
  "turn_done",
  "error",
]);

class JcodeSession implements HarnessSession {
  readonly sessionRef: string;
  /**
   * Drained into the FIRST turn, then dropped. A degraded preference is a
   * property of the session, not of each message — repeating it on every turn
   * would scold the user forever for one mis-set field.
   */
  private pendingNotices: string[];
  /** The in-flight gate: `steer` refuses between turns (see the contract). */
  private turnActive = false;
  /**
   * Set by `abort()` and read by the self-heal loop: a stopped turn must
   * never be resent — the user's cancel outranks the recovery.
   */
  private abortRequested = false;
  /** Steers delivered to the LIVE turn, reconciled at its terminal. */
  private pendingSteers: SteerInput[] = [];
  /**
   * History length right after this turn's message was accepted — the floor
   * of the reconcile window. Anchoring by INDEX beats content-matching the
   * prompt: a steer whose text EQUALS the prompt (an impatient verbatim
   * resend) would otherwise become the anchor itself and read every earlier
   * injection out of the window. Null when the read failed — the reconcile
   * falls back to the prompt-content anchor.
   */
  private turnHistoryBaseline: number | null = null;

  constructor(
    private readonly client: JcodeClient,
    sessionId: string,
    notices: string[] = [],
    private readonly onRelease?: () => Promise<void>,
  ) {
    this.sessionRef = sessionId;
    this.pendingNotices = notices;
  }

  /**
   * Drop this session's client so its ref is no longer HELD in this
   * process: the next `startSession({ resumeSessionRef })` attaches to the
   * same daemon session (same transcript) on a fresh connection, which is
   * where jcode re-reads the instruction doc and re-lists the MCP tools.
   * Without the release, the resume path would see a live holder and mint
   * a fresh, memoryless session instead (the duplicate-ref guard).
   */
  async release(): Promise<void> {
    // The contract says never mid-turn; hold the line here too, because a
    // released client mid-stream would orphan the run's events. A caller
    // that gets this refusal has a sequencing bug, not a retry case.
    if (this.turnActive) {
      throw new Error("release() called with a turn in flight");
    }
    await this.onRelease?.();
  }

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    // Subscribe BEFORE sending, or a short turn's first deltas race the
    // subscription (verified SDK behavior — run() does the same).
    const stream = this.client.events(
      this.sessionRef,
    ) as AsyncIterableIterator<ApiEvent>;
    let usage: TurnUsage | undefined;
    let terminal: Extract<AgentEvent, { type: "turn.done" | "error" }> | null =
      null;

    // THE FRAME FENCE. The daemon can run turns it did not receive from us,
    // and their frames are indistinguishable from ours: no ids on deltas,
    // and the bridge drops the self-started terminal. External wake
    // ownership (JCODE_WAKE_MODE=external, v0.81+) removes the BIG source —
    // background/fan-out/comm self-wake turns — but the fence stays as
    // defense-in-depth: two daemon turn-starters remain ungated upstream
    // (`notify_session`, interrupted-session recovery), abandoned orphans of
    // our own are version-independent, and the mode is an env we set, not a
    // guarantee. The fence is `message_accepted` — the bridge's translation
    // of the daemon's ack for OUR `message` request. The daemon writes that
    // ack on its request loop BEFORE dispatching the message to the turn
    // task (client_lifecycle.rs, "Send ack" precedes the `match request`),
    // so it is causally ahead of every frame our turn can produce, and it
    // carries our session id, so the SDK's stream filter already scopes it.
    // Every frame before it is provably another run's; every frame after it
    // on this per-conversation connection is ours.
    //
    // WHY NOT A REQUEST REPLY (issue #1124, three live occurrences). The
    // previous fence was the reply to a `get_history` issued after the send,
    // on the theory that the request loop cannot answer it until our turn
    // has spawned. The daemon answers `get_history` from a fast path when
    // the agent mutex is busy — but it probes with `try_lock`, drops the
    // guard, and then takes the real lock; when the probe wins the race
    // against the turn task by a few microseconds, the reply blocks for the
    // WHOLE TURN and lands after our terminal. Every frame of our own turn
    // was then quarantined, the terminal included, and this loop waited out
    // the 6 h ceiling (jcode#1284). A fence must be a causal fact about our
    // send, never a timing bet on an unrelated request.
    //
    // Armed from TURN START (frames in the subscribe→send gap are foreign
    // too — an orphan finishing naturally in that gap used to read as an
    // instant empty end; now it is quarantined like any foreign frame).
    let barrierPending = true;
    /** Stops the reconcile-baseline read once the turn is over: a late
     * `history` reply must not overwrite the next turn's floor. */
    let baselineStopped = false;
    let droppedForeignFrames = 0;
    let droppedForeignTextChars = 0;
    let exclusionNoticeSent = false;
    const exclusionNotice = (): Extract<AgentEvent, { type: "notice" }> => ({
      type: "notice",
      level: "warn",
      text: "Output from a background run on this agent overlapped with your message and was excluded from this reply. Ask the agent to repeat anything you were expecting.",
    });

    // ONE background reader owns `stream.next()` for the turn's whole life.
    // The SDK iterator holds a single waker slot, so racing `next()` against
    // timers directly would orphan a waker and silently drop the frame that
    // resolves it — every timed read below goes through this queue instead.
    // Frames are stamped foreign AT ENQUEUE, not when processed: the fence
    // flips while the consumer may be parked mid-`yield`, and a flag checked
    // at processing time would launder pre-fence frames received across
    // that suspension. Enqueue order is stream order — the honest oracle.
    //
    // The fence itself is ALSO dropped at enqueue: `message_accepted` is
    // where the line is drawn, so it flips the flag as it is queued and is
    // never itself stamped foreign. A `message_accepted` for a message we
    // did not send cannot exist on this connection (the bridge mints it only
    // for its own `pending_message_id`), so no session check is needed
    // beyond the SDK's stream filter.
    const queue: { frame: ApiEvent; foreign: boolean }[] = [];
    let streamEnded = false;
    let wakeReader: (() => void) | undefined;
    const pump = (async () => {
      try {
        for await (const frame of stream) {
          if (frame.ev === "message_accepted") {
            barrierPending = false;
          }
          queue.push({ frame, foreign: barrierPending });
          wakeReader?.();
          wakeReader = undefined;
        }
      } catch {
        // A stream rejection reads as an unexpected end; the loop below
        // synthesizes the terminal.
      } finally {
        streamEnded = true;
        wakeReader?.();
        wakeReader = undefined;
      }
    })();
    /** Next entry, or "ended", or — when a deadline is given — "timeout". */
    const nextEntry = async (
      deadline?: number,
    ): Promise<{ frame: ApiEvent; foreign: boolean } | "ended" | "timeout"> => {
      for (;;) {
        const entry = queue.shift();
        if (entry !== undefined) return entry;
        if (streamEnded) return "ended";
        const waitMs =
          deadline === undefined ? undefined : deadline - Date.now();
        if (waitMs !== undefined && waitMs <= 0) return "timeout";
        await new Promise<void>((resolve) => {
          wakeReader = resolve;
          if (waitMs !== undefined) {
            const timer = setTimeout(() => {
              if (wakeReader === resolve) wakeReader = undefined;
              resolve();
            }, waitMs);
            timer.unref();
          }
        });
      }
    };
    /** An orphaned reply to one of our own timed-out requests — the daemon
     * answered after the SDK gave up, and the SDK re-emits unmatched replies
     * as events. A request reply is never a turn event, whatever its `ev`
     * (observed live: a deferred set_reasoning_effort reply killing an
     * unrelated stream; baseline attempts add stale `history` replies). */
    const isStaleReply = (frame: ApiEvent): boolean =>
      (frame as { reply_to?: number }).reply_to !== undefined;
    /** Count-and-drop a foreign frame. Only the counts survive — the notice
     * needs no content, and foreign usage/tools must not be recorded. Frames
     * the live loop would ignore anyway (acks, status broadcasts — our own
     * send's `message_accepted` is the fence itself, never foreign) are not
     * counted: they are dropped either way and would page on every turn. */
    const quarantine = (frame: ApiEvent): void => {
      if (frame.ev === "permission_request") {
        // A foreign run's unanswered permission prompt would wedge the
        // daemon (and the mutex our send waits on) forever — auto-allow it
        // exactly like our own, just without surfacing anything.
        void this.client
          .respondToPermission(this.sessionRef, frame.request_id, "allow")
          .catch(() => {});
        return;
      }
      if (!QUARANTINE_COUNTED.has(frame.ev)) return;
      droppedForeignFrames += 1;
      if (frame.ev === "text_delta" || frame.ev === "reasoning_delta") {
        droppedForeignTextChars += frame.text.length;
      }
    };

    try {
      // Drop interrupts leaked from a previous turn's very end: jcode holds
      // an undelivered soft interrupt and injects it into the NEXT turn at
      // its first safe point — a mid-run message must never resurface in a
      // later, unrelated run. Running this BEFORE the gate opens also closes
      // the cancel-vs-steer ordering race at the source. Best-effort: a
      // refusal here must not cost the turn.
      await this.client.cancelSoftInterrupts(this.sessionRef).catch(() => {});
      this.pendingSteers = [];
      this.abortRequested = false;
      this.turnActive = true;
      // A stale floor from a previous turn must never survive into this
      // one's reconcile: if the baseline read below never resolves (stream
      // death mid-freeze), reconcile degrades to the content anchor — the
      // safe direction (a duplicate beats a loss) — instead of matching
      // against an old-era window.
      this.turnHistoryBaseline = null;

      // Inline vision: our TurnImage translates to jcode's [mediaType,
      // base64] tuple HERE and nowhere else (invariant 9 — the vendor shape
      // never crosses the adapter boundary). The daemon prepends the images
      // as content blocks in the same user message (verified v0.71.1,
      // unchanged through v0.81.1).
      const images = (input.images ?? []).map((image): [string, string] => [
        image.mediaType,
        image.dataBase64,
      ]);
      const imagesArg = images.length > 0 ? images : undefined;

      // The reconcile FLOOR: a `get_history` issued right after each send,
      // captured by INDEX at our spawn — everything a wake turn appended
      // sits below it, and injection points exist only inside our own turn
      // loop. NOT awaited inline: the daemon can answer it only after it has
      // the agent mutex, which a foreign run (or, via jcode#1284's probe
      // race, OUR OWN run) may hold for its whole life. It gates NOTHING —
      // the frame fence is `message_accepted` (see the pump) — so a slow or
      // failed read costs only the index anchor: reconcile then degrades to
      // the content anchor. Sequential retries through SDK timeouts, no
      // delay; any other failure leaves the floor null after one attempt.
      const readBaseline = () => {
        void (async () => {
          for (;;) {
            if (baselineStopped || this.abortRequested) return;
            try {
              const history = await this.client.getHistory(this.sessionRef);
              if (!baselineStopped) this.turnHistoryBaseline = history.length;
            } catch (error) {
              if (errorCode(error) === "timeout" && !baselineStopped) {
                log("warn", "reconcile baseline read timed out; retrying", {
                  sessionRef: this.sessionRef,
                });
                continue;
              }
              if (!baselineStopped) this.turnHistoryBaseline = null;
            }
            return;
          }
        })();
      };

      // The fence is re-armed for every send, including the self-heal's
      // resends: each send earns its own `message_accepted`, and frames
      // between a refused send and the next accepted one are the orphan's.
      const armFence = () => {
        barrierPending = true;
        readBaseline();
      };

      // `waitForAccept: false`, deliberately: the SDK's default awaits
      // `message_accepted` INSIDE the send with a 10 s timeout, which would
      // (a) hide the fence's arrival from the pump, where the stamp must
      // happen, and (b) stall this generator — and every abort behind it —
      // for the daemon's request-loop latency. The pump sees the ack as an
      // ordinary frame and drops the fence exactly where it lands in stream
      // order.
      await this.client.sendMessage(this.sessionRef, input.message, {
        ...(imagesArg && { images: imagesArg }),
        waitForAccept: false,
      });
      armFence();
      yield { type: "turn.started" };

      for (const text of this.pendingNotices.splice(0))
        yield { type: "notice", level: "warn", text };

      // THE SETTLE PHASE — the busy self-heal. The daemon acks sends before
      // deciding whether to take them, so acceptance is only learnable from
      // the stream: a refusal ("Already processing a message") lands as a
      // broadcast error frame ~150ms after the send. On this per-conversation
      // connection the only run that can be holding the session is this
      // conversation's own earlier, platform-abandoned one — an ORPHAN — so
      // the recovery is to cancel it and resend, bounded. Frames arriving
      // before the send settles are HELD, not yielded: an actively-streaming
      // orphan's output must never leak into this turn's answer. Deliberately
      // NOT cancelling soft interrupts here — user messages queued during the
      // busy window must survive into the resent run.
      const held: ApiEvent[] = [];
      let healRound = 0;
      settle: for (;;) {
        if (this.abortRequested) {
          // The user's stop outranks the recovery: end cleanly (the fake's
          // abort precedent); the supervisor's own abort bookkeeping reports
          // the turn aborted.
          terminal = { type: "turn.done" };
          break settle;
        }
        const windowEnd = Date.now() + BUSY_DETECT_WINDOW_MS;
        for (;;) {
          const entry = await nextEntry(windowEnd);
          // Window elapsed or stream gone: the held frames are ours; the
          // live loop below owns the rest (including synthesizing the
          // unexpected-end terminal).
          if (entry === "timeout" || entry === "ended") break settle;
          const frame = entry.frame;
          if (isStaleReply(frame)) continue;
          if (
            frame.ev === "error" &&
            healRound > 0 &&
            !this.abortRequested &&
            ORPHAN_CANCEL_SHAPE.test(frame.message ?? "")
          ) {
            // The cancelled orphan's own death rattle, not our terminal.
            continue;
          }
          // The busy check MUST run before the foreign quarantine: the
          // refusal is broadcast while the daemon processes our send — and
          // on a healthy daemon it FOLLOWS our ack (the ack precedes
          // dispatch), but the bridge's ack and the refusal ride different
          // daemon-side paths to one socket writer, so the stamp is not
          // relied on. A busy refusal is ours whatever it is stamped:
          // quarantining it would kill the self-heal.
          if (
            frame.ev === "error" &&
            BUSY_REFUSAL_SHAPE.test(frame.message ?? "")
          ) {
            // Our send was refused — everything held so far was the orphan's.
            // The orphan's discard has always been silent (the heal is the
            // recovery, not an incident): the foreign counters reset with it
            // so no exclusion notice is minted for healed residue.
            held.length = 0;
            droppedForeignFrames = 0;
            droppedForeignTextChars = 0;
            if (healRound >= BUSY_RESEND_DELAYS_MS.length) {
              terminal = {
                type: "error",
                message: frame.message,
                code: TURN_FAILURE_CODES.harnessBusy,
              };
              break settle;
            }
            await this.client.cancel(this.sessionRef).catch(() => {});
            // Drain the dying orphan's residue through the backoff, then
            // resend into the freed session.
            const drainEnd =
              Date.now() +
              Math.max(
                BUSY_RESEND_DELAYS_MS[healRound] ?? 0,
                ORPHAN_DRAIN_MIN_MS,
              );
            for (;;) {
              const drained = await nextEntry(drainEnd);
              if (drained === "timeout" || drained === "ended") break;
              if (this.abortRequested) break;
            }
            healRound += 1;
            if (this.abortRequested) {
              terminal = { type: "turn.done" };
              break settle;
            }
            await this.client.sendMessage(this.sessionRef, input.message, {
              ...(imagesArg && { images: imagesArg }),
              waitForAccept: false,
            });
            armFence();
            continue settle;
          }
          // Pre-fence frames are another run's — the self-wake turn our
          // accepted send is queued behind (or an orphan finishing in the
          // subscribe→send gap, the residual this closes). Count and drop;
          // never held, never a terminal. TERMINALS INCLUDED, deliberately:
          // the bridge's `pending_message_id` is the PREVIOUS turn's until
          // our send overwrites it, so an orphan's `done` in that gap is
          // emitted as a `turn_done`, and a foreign `error` that matches
          // no request is streamed as an `error` event. Both are
          // pre-fence by definition (they precede our ack), and adopting
          // either would end this turn with another run's outcome. Our own
          // terminal can never be pre-fence — the ack precedes dispatch —
          // which is exactly what makes the fence safe to trust.
          if (entry.foreign) {
            quarantine(frame);
            continue;
          }
          held.push(frame);
          // A non-busy terminal inside the window is ours: a busy refusal
          // always precedes any orphan frame that could follow our send.
          if (frame.ev === "turn_done" || frame.ev === "error") break settle;
        }
      }

      // Whether this run visibly progressed — a busy refusal can only be OUR
      // send's (the daemon mints it nowhere else), so one that slips past the
      // settle window still deserves its honest code, but only while nothing
      // has streamed (post-progress it cannot be a send refusal).
      let progressed = false;
      // THE LIVE LOOP'S CLOCKS (#1124). Three deadlines, one `nextEntry`:
      //
      // - Fence pending: the short tick. Our send may be queued behind a
      //   foreign run holding the daemon's request loop, so an abort's
      //   `cancel` cannot be confirmed; the tick honors it directly.
      // - Fence down, abort requested: `ABORT_TERMINAL_GRACE_MS` from the
      //   abort. The daemon ends a cancelled turn in ≤ 2.5 s; past the grace
      //   the daemon had nothing to cancel (or lost its terminal) and this
      //   loop ends the turn itself, aborted. Stop is a guarantee.
      // - Fence down, no abort, no tool open: `POST_ACCEPT_IDLE_MS` of
      //   silence — no frame of ANY kind, foreign or not — fails the turn
      //   coded `harness_no_terminal`. A tool call in flight suspends it (a
      //   `bg wait` is legitimately silent for as long as it likes; its
      //   `tool_done` restarts the clock).
      //
      // The clock is reset by every dequeued frame, trusted or foreign: a
      // foreign frame still proves the stream is alive.
      let lastFrameAt = Date.now();
      let abortSeenAt: number | undefined;
      let openToolCalls = 0;
      while (!terminal) {
        if (this.abortRequested && abortSeenAt === undefined) {
          abortSeenAt = Date.now();
        }
        // Held frames were already classified by the settle phase (foreign
        // ones never reached `held`), so they re-enter trusted; fresh ones
        // carry their enqueue stamp.
        const heldFrame = held.shift();
        const deadline = barrierPending
          ? Date.now() + BARRIER_TICK_MS
          : abortSeenAt !== undefined
            ? abortSeenAt + ABORT_TERMINAL_GRACE_MS.value
            : openToolCalls > 0
              ? undefined
              : lastFrameAt + POST_ACCEPT_IDLE_MS.value;
        const entry =
          heldFrame !== undefined
            ? { frame: heldFrame, foreign: false }
            : await nextEntry(deadline);
        if (entry === "ended") break;
        if (entry === "timeout") {
          if (this.abortRequested) {
            // Which clock fired? Under a standing fence it was the tick:
            // end now. Past the fence it was the abort grace — unless the
            // abort landed while the IDLE deadline was armed, in which case
            // this timeout is the idle clock's and the grace has not run:
            // loop once more so the deadline above is re-derived from
            // `abortSeenAt`.
            if (barrierPending) {
              terminal = { type: "turn.done" };
              break;
            }
            if (abortSeenAt === undefined) continue;
            if (Date.now() < abortSeenAt + ABORT_TERMINAL_GRACE_MS.value) {
              continue;
            }
            log("warn", "abort grace elapsed without a terminal", {
              sessionRef: this.sessionRef,
            });
            terminal = { type: "turn.done" };
            break;
          }
          if (barrierPending) continue;
          log("error", "no frame within the post-accept deadline", {
            sessionRef: this.sessionRef,
            idleMs: Date.now() - lastFrameAt,
            droppedForeignFrames,
          });
          terminal = {
            type: "error",
            message: `harness delivered no frame for ${Math.round((Date.now() - lastFrameAt) / 1000)}s after accepting the turn`,
            code: TURN_FAILURE_CODES.harnessNoTerminal,
          };
          break;
        }
        lastFrameAt = Date.now();
        const event = entry.frame;
        if (isStaleReply(event)) continue;
        // Foreign frames, terminals included, are quarantined (the settle
        // phase says why a foreign terminal is real). Post-fence, every
        // frame is ours.
        if (entry.foreign) {
          quarantine(event);
          continue;
        }
        // The exclusion is never silent: one warn notice ahead of our own
        // frames tells the reader overlapping background output was kept
        // out of this reply (it survives in the session's own history).
        if (!exclusionNoticeSent && droppedForeignTextChars > 0) {
          exclusionNoticeSent = true;
          yield exclusionNotice();
        }
        switch (event.ev) {
          case "text_delta":
            progressed = true;
            yield { type: "text.delta", text: event.text };
            break;
          case "reasoning_delta":
            progressed = true;
            yield { type: "thinking.delta", text: event.text };
            break;
          case "tool_start":
            progressed = true;
            openToolCalls += 1;
            yield {
              type: "tool.started",
              callId: event.call_id,
              name: event.name,
            };
            break;
          case "tool_done":
            openToolCalls = Math.max(0, openToolCalls - 1);
            yield {
              type: "tool.finished",
              callId: event.call_id,
              name: event.name,
              output: event.output,
              ...(event.error ? { isError: true } : {}),
            };
            break;
          case "token_usage":
            usage = usageFromEvent(event);
            break;
          case "permission_request":
            // Local tool actions are auto-allowed: gating lives at the
            // network boundary (§3.1), where the gateway holds real
            // approvals. This prompt is jcode-internal only. Caught: during
            // a frozen request loop the response itself times out, and a
            // best-effort allow must not fail the turn.
            await this.client
              .respondToPermission(this.sessionRef, event.request_id, "allow")
              .catch(() => {});
            break;
          case "turn_done":
            terminal = { type: "turn.done", ...(usage ? { usage } : {}) };
            break;
          case "error": {
            // A failed turn emits `error` INSTEAD of `turn_done` (verified) —
            // terminating here is what keeps the loop from hanging forever.
            // (Orphaned request replies were already skipped above.)
            // A busy refusal that outran the settle window (a loaded daemon
            // can answer late) still gets its honest code — no retry at this
            // point, but never the silent uncoded shape again.
            const lateBusy =
              !progressed && BUSY_REFUSAL_SHAPE.test(event.message ?? "");
            terminal = {
              type: "error",
              message: event.message,
              ...(lateBusy
                ? { code: TURN_FAILURE_CODES.harnessBusy }
                : event.code
                  ? { code: event.code }
                  : {}),
            };
            break;
          }
          default:
            // Forward-compat: unknown vendor events are dropped, never leaked.
            break;
        }
      }

      if (!terminal) {
        terminal = {
          type: "error",
          message: "harness event stream ended unexpectedly",
        };
      }

      // A turn that ended without a single trusted frame after the fence
      // (stream death, abort under a freeze) still owes the exclusion story.
      if (!exclusionNoticeSent && droppedForeignTextChars > 0) {
        exclusionNoticeSent = true;
        yield exclusionNotice();
      }
      // Logged at the end, when the counts are final (frames are counted as
      // they are consumed, not as they arrive). `fenceDown` is the #1124
      // tell: a quarantine on a turn whose fence NEVER dropped means the
      // adapter never saw its own ack — a bridge/daemon regression, not an
      // overlap — and must read as one in the log.
      if (droppedForeignFrames > 0) {
        log("warn", "frame fence quarantined a foreign run's frames", {
          sessionRef: this.sessionRef,
          frames: droppedForeignFrames,
          textChars: droppedForeignTextChars,
          fenceDown: !barrierPending,
        });
      }

      // ONE exit point: whatever ended the turn, confirm which steers made
      // it in and say so BEFORE the terminal event (the supervisor stops
      // listening after it).
      for (const followUpId of await this.reconcileSteers(input.message)) {
        yield { type: "message.joined", followUpId };
      }
      yield terminal;
    } finally {
      baselineStopped = true;
      this.turnActive = false;
      await stream.return?.(undefined);
      await pump.catch(() => {});
    }
  }

  /**
   * Queue a message into the live turn at jcode's next safe injection point.
   * A soft interrupt is queued daemon-side under its own lock — legal while
   * the turn streams — and injected as a user message between tool batches
   * or as the model finishes (which EXTENDS the turn instead of ending it).
   *
   * Any coded refusal propagates as a throw and means NOTHING was injected.
   * The bridge accepts `soft_interrupt` / `get_history` /
   * `cancel_soft_interrupts` only for the connection's attached session —
   * which is exactly this session, because every conversation owns its own
   * connection (concurrent conversations steer first-class now; the old
   * shared-connection degrade to promotion is gone).
   */
  async steer(input: SteerInput): Promise<void> {
    if (!this.turnActive) {
      throw new Error("no turn in flight");
    }
    await this.client.softInterrupt(this.sessionRef, input.message, false);
    this.pendingSteers.push(input);
  }

  /**
   * The turn ended — settle every steer it was handed. `cancelSoftInterrupts`
   * first: after it, nothing more can inject (jcode's injection points exist
   * only inside the turn loop), so the history read is stable. Then the pure
   * matcher above, over user entries AFTER this turn's own prompt. Any
   * failure degrades every pending steer to missed — the control plane
   * re-runs the message as its own turn, and a possible duplicate beats a
   * lost word.
   */
  private async reconcileSteers(prompt: string): Promise<string[]> {
    const pending = this.pendingSteers.splice(0);
    this.turnActive = false;
    try {
      await this.client.cancelSoftInterrupts(this.sessionRef);
      if (pending.length === 0) return [];
      const history = await this.client.getHistory(this.sessionRef);

      // The window floor. Preferred anchor: the INDEX captured right after
      // this turn's message was accepted — immune to a steer whose text
      // equals the prompt. If the baseline read was slightly early (the
      // prompt not yet persisted), the prompt entry sits AT the floor and is
      // skipped by content; injections are always later entries.
      let floor = -1;
      if (this.turnHistoryBaseline !== null) {
        floor = this.turnHistoryBaseline;
        const atFloor = history[floor];
        if (atFloor && atFloor.role === "user" && atFloor.content === prompt) {
          floor += 1;
        }
      } else {
        // Fallback: the LAST user entry equal to the prompt (histories span
        // resumed turns, so earlier turns can hold the same text). Known
        // safe-direction degrade: a steer whose text equals the prompt then
        // anchors past its own injection and reads missed → promotion re-runs
        // it (a duplicate beats a loss).
        for (let i = history.length - 1; i >= 0; i -= 1) {
          const entry = history[i];
          if (entry && entry.role === "user" && entry.content === prompt) {
            floor = i + 1;
            break;
          }
        }
        // No anchor at all: the window cannot be bounded — everything missed.
        if (floor === -1) return [];
      }

      const candidates = history
        .slice(floor)
        .filter((entry) => entry.role === "user")
        .map((entry) => entry.content);
      return matchJoinedSteers(pending, candidates);
    } catch (error) {
      log("warn", "steer reconcile failed; reporting all missed", {
        error: String(error),
      });
      return [];
    }
  }

  async abort(): Promise<void> {
    // FIRST, before any await: the live loop and the self-heal loop check
    // this between their waits — a stopped turn must never be resent, and
    // the loop's abort grace starts counting from this flag, not from the
    // daemon's reply.
    this.abortRequested = true;
    // Stop means silence, daemon-side too: queued-but-undelivered interrupts
    // die with the turn instead of leaking into the next one.
    await this.client.cancelSoftInterrupts(this.sessionRef).catch(() => {});
    // `cancel()` resolves on the daemon's ack. The daemon then ends a
    // running turn within ≤ 2.5 s and emits its terminal on the stream;
    // runTurn's loop consumes that, or — when the daemon had nothing to
    // cancel (#1124) — ends the turn itself once ABORT_TERMINAL_GRACE_MS
    // has elapsed. Either way the caller's `await` here is not the end of
    // the turn; the generator's terminal is.
    await this.client.cancel(this.sessionRef);
  }
}

export const createJcodeHarness = (): Harness => {
  /**
   * The launched daemon instance — ONE per container, memoized as a PROMISE:
   * `launchInstance` is destructive on re-entry (it unlinks the live socket
   * and spawns a second daemon onto the same state dir), so a second launch
   * must be structurally impossible, not merely unlikely. A rejected memo
   * stays memoized on purpose — a container whose runtime will not launch is
   * dead, and every later turn should fail identically instead of retrying
   * the destructive launch.
   */
  let instance: Promise<Awaited<ReturnType<typeof launchInstance>>> | undefined;
  /**
   * The daemon's own log file, re-emitted through `log()` (jcode-log.ts).
   * Started at launch (once per container, like the instance) and
   * stopped on dispose. The daemon's file is where its errors live; its
   * stderr carries almost nothing.
   */
  let logForwarder: ReturnType<typeof startJcodeLogForwarder> | undefined;
  /**
   * Per-conversation connections (§3.6): the bridge binds ONE session per
   * connection, so sharing a connection is what made a second conversation
   * attach to the first's busy session (the stuck-sandbox incident). Every
   * `startSession` dials its own connection; the maps below exist for
   * dispose and the duplicate-resume-ref guard.
   */
  const clients = new Set<JcodeClient>();
  const sessionClients = new Map<string, JcodeClient>();
  /** sessionId → the conversation it serves (from StartSessionOptions.context)
   * — how a between-turns wake event finds its chat. */
  const sessionConversations = new Map<string, string>();
  /** External wake requests, mirrored as synthetic observed tasks. */
  const wakeFeed = createJcodeWakeFeed();
  /**
   * The daemon's LEGACY socket, set once the instance is up. The swarm
   * mirror's roster query lives on it — the api-bridge (the socket the SDK
   * dials) drops every swarm frame, so this is the only externally-visible
   * helper lifecycle at the pinned version (contract in jcode-swarm.ts).
   */
  let legacySocketPath: string | undefined;
  /** Connections WE closed — their `close` event is teardown, not death. */
  const deliberateCloses = new WeakSet<JcodeClient>();
  let connectionCounter = 0;
  let onFailure: ((reason: string) => void) | undefined;
  /** Terminal failure is reported once, and never for our own teardown. */
  let failed = false;
  let disposing = false;

  const fail = (reason: string) => {
    if (failed || disposing) return;
    failed = true;
    log("error", "jcode harness failed terminally", { reason });
    onFailure?.(reason);
  };

  const closeClient = async (client: JcodeClient): Promise<void> => {
    deliberateCloses.add(client);
    clients.delete(client);
    for (const [ref, holder] of sessionClients) {
      if (holder === client) {
        sessionClients.delete(ref);
        sessionConversations.delete(ref);
      }
    }
    await client.close().catch(() => {});
  };

  const ensureInstance = (
    homeDir: string,
  ): Promise<Awaited<ReturnType<typeof launchInstance>>> => {
    if (instance) return instance;
    instance = launchDaemon(homeDir);
    return instance;
  };

  const launchDaemon = async (
    homeDir: string,
  ): Promise<Awaited<ReturnType<typeof launchInstance>>> => {
    // §3.6: the harness's own session state lives ON the home volume,
    // which is exactly what makes resume survive a container stop/start.
    const jcodeHome = join(homeDir, JCODE_HOME_DIRNAME);
    mkdirSync(jcodeHome, { recursive: true });
    // The pin's volume half: every boot converges the home onto the vendored
    // binary, healing volumes that self-updated before the pin existed.
    cleanJcodeUpdaterState(jcodeHome);
    // The no-alternatives half: native memory/notes graphs and unmanaged
    // skill stashes do not survive a boot — platform memory and the synced
    // skills root are the only durable knowledge.
    cleanJcodeKnowledgeStores(homeDir, jcodeHome);
    // The transcript half: a stop that tore the daemon's last checkpoint
    // left every journaled message doubled, which the provider rejects on
    // every turn (#1194). Repaired here, while no daemon holds the store.
    healJcodeTranscripts(jcodeHome);
    writeManagedFile(join(jcodeHome, "config.toml"), managedConfigToml, 0o600);
    preparePromptFiles(homeDir, jcodeHome);
    prepareMcpConfig(homeDir, jcodeHome, platformToolsSocketPath());
    // Before the launch, so the daemon's own startup lines are forwarded
    // too: creating the follower pins the end of whatever a PREVIOUS boot
    // left in today's file, and everything this boot appends is read.
    logForwarder ??= startJcodeLogForwarder({ jcodeHome });

    // OAuth-mode grants ship CLAUDE_CODE_OAUTH_TOKEN (a placeholder — the
    // gateway splices the real token); steer jcode onto its subscription
    // path for that case. Api-key mode needs no steering.
    const oauthMode =
      Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) &&
      !process.env.ANTHROPIC_API_KEY;

    if (oauthMode) {
      // Seed jcode's OWN auth store with a never-expiring placeholder
      // account (live-verified: a bare env token is marked expired and the
      // runtime refuses it at request time — "only useful while still
      // valid"). The store account with a future `expires` and an empty
      // `refresh` passes both runtime guards, jcode sends
      // `Authorization: Bearer <placeholder>`, and the gateway's OAuth-mode
      // ReplaceHeader splices the real token at the wire. Same pattern as
      // the platform's existing Codex auth.json stub — a placeholder file,
      // never a credential.
      // 0600 even though the value is a placeholder: this file is
      // credential-SHAPED, and the mode must already be right on the day
      // something real is ever considered for it.
      // jcode canonicalizes account labels on load (renames them and
      // re-saves the file), so nothing may ever assert the "onecli" label
      // on disk — it exists only to be a valid non-empty string.
      writeManagedFile(
        join(jcodeHome, "auth.json"),
        `${JSON.stringify({
          anthropic_accounts: [
            {
              label: "onecli",
              access: process.env.CLAUDE_CODE_OAUTH_TOKEN,
              refresh: "",
              expires: 4102444800000, // 2100-01-01 — refresh never triggers
              subscription_type: "max",
            },
          ],
          active_anthropic_account: "onecli",
        })}\n`,
        0o600,
      );
    }

    const launched = await launchInstance({
      workingDir: homeDir,
      jcodeHome,
      // Pinned, never the SDK's guess (which ends at bare "jcode" on PATH).
      binary: resolveJcodeBinary(),
      inheritLogins: false,
      startupTimeoutMs: 60_000,
      env: {
        JCODE_NO_TELEMETRY: "1",
        // Presence-based upstream (any value disables, even "0"): without it
        // the runtime checks for updates at every process start and execs
        // itself mid-run when one exists — which killed every fresh agent's
        // first turn. The image bakes it too; here covers local dev.
        JCODE_NO_AUTO_UPDATE: "1",
        JCODE_DISABLED_TOOLS: JCODE_DISABLED_TOOLS_VALUE,
        // The swarm fence (cap + headless default). Env, not config.toml,
        // on purpose: the harness re-applies env overrides on every config
        // reload, so this survives an agent editing its own writable
        // config — the managed TOML's swarm=true is the switch, these are
        // the limits. See JCODE_SWARM_ENV's doc for the verified mechanics.
        ...JCODE_SWARM_ENV,
        // Provider-native web search posture — see JCODE_WEBSEARCH_ENV.
        ...JCODE_WEBSEARCH_ENV,
        // EXTERNAL WAKE OWNERSHIP (v0.81+): the daemon never starts turns on
        // its own — background/swarm-await/comm wakes surface as typed
        // `wake_requested` events the adapter converts into platform wakes
        // (jcode-wake.ts). Inert on older daemons (unknown env ignored), so
        // this ships safely ahead of the image bump. NOT reload-fingerprinted
        // upstream, which is fine: it is set once here, at spawn.
        JCODE_WAKE_MODE: "external",
        // The platform-tool cliff fence — see JCODE_MCP_TOOLS_ENV_VALUE.
        JCODE_MCP_TOOLS: JCODE_MCP_TOOLS_ENV_VALUE,
        // prepareMcpConfig deletes the Claude-compat MCP files per boot, but
        // jcode re-reads MCP config at every session construction — a file
        // planted mid-container-life would load before the next boot heals
        // it. This presence-based env (v0.77+) closes that window for
        // external/.claude.json + external/.claude/mcp.json; the deletes
        // stay for the project-local overrides it does not cover.
        JCODE_DISABLE_CLAUDE_MCP: "1",
        // NO JCODE_MODEL here, deliberately. It would be a second way to set
        // the model — process-wide, read straight off the environment, and
        // bypassing `StartSessionOptions` — so a caller passing a different
        // model would get a launch env and a session model that disagree.
        // `setModel` in `applyPreferences` is the single door.
        ...(oauthMode ? { JCODE_PROVIDER: "claude" } : {}),
      },
    });

    // ONE of the two death signals this adapter owes the supervisor: the
    // bridge process exiting means no connection can ever be served again.
    // The per-connection `close` handler below is the other (and usually
    // faster) signal — first one wins, `fail` is one-shot. The exit code /
    // signal ride the reason: "exited" alone cannot tell an OOM kill from a
    // panic from a clean stop.
    launched.process.once(
      "exit",
      (code: number | null, signal: NodeJS.Signals | null) => {
        fail(
          `jcode instance exited (code ${String(code)}, signal ${String(signal)})`,
        );
      },
    );
    // The SDK pipes the bridge's stderr and keeps only a startup-failure
    // tail; a crash AFTER startup would otherwise leave no trace.
    forwardJcodeStderr(launched.process.stderr);

    // The SDK pins both sockets into ONE runtime dir (`<jcodeHome>/run`):
    // `jcode-api.sock` (what it hands back) beside `jcode.sock` (the daemon's
    // legacy listener the roster mirror queries).
    legacySocketPath = join(dirname(launched.socketPath), "jcode.sock");

    return launched;
  };

  /**
   * Dial a fresh connection for one conversation. The bridge binds exactly
   * one session per connection, so this is what gives every conversation its
   * own session, its own busy state, and its own event scope — the incident's
   * root fix. Mirrors the SDK's own `globalEvents` child-connection pattern.
   */
  const connectClient = async (homeDir: string): Promise<JcodeClient> => {
    const inst = await ensureInstance(homeDir);
    connectionCounter += 1;
    const connected = await JcodeClient.connect({
      socketPath: inst.socketPath,
      clientName: `onecli-supervisor/0/conv-${connectionCounter}`,
    });

    // Node treats an unlistened "error" as fatal; the SDK reserves it for
    // transport faults and remaps protocol errors to "harness_error". Both
    // are per-EventEmitter, so every connection needs its own listeners.
    connected.on("error", (err) => {
      log("error", "jcode transport error", { error: String(err) });
    });
    connected.on(
      "harness_error",
      (frame: { code?: string; message?: string }) => {
        // Code + message only: a whole vendor frame can carry request/response
        // content, and these lines land in container logs (host-local; the
        // runner ships nothing of them).
        log("warn", "harness error frame", {
          code: frame.code ?? null,
          message: frame.message ?? null,
        });
      },
    );

    // EXTERNAL WAKE requests (v0.81+, JCODE_WAKE_MODE=external): the daemon
    // asks its operator to wake a session instead of starting a turn itself.
    // A STANDING listener, because the event fires between turns when no
    // events() iterator is being consumed — and the SDK emits every frame on
    // a per-kind channel even for kinds its typings predate, so this works
    // on the pinned client with one local shape. Gated to the session this
    // connection OWNS (helper/broadcast wakes are not ours to act on), and
    // attributed via the conversation the session serves. During a turn the
    // events() iterator sees the same frame and drops it (default arm /
    // uncounted quarantine) — this listener is the single consumer.
    connected.on(
      "wake_requested",
      (frame: {
        session_id?: string;
        reason?: string;
        notification?: string;
      }) => {
        const sessionId = frame.session_id;
        if (!sessionId || sessionClients.get(sessionId) !== connected) return;
        const conversationId = sessionConversations.get(sessionId);
        if (!conversationId) {
          log("warn", "wake request for a session with no conversation", {
            sessionId,
            reason: frame.reason ?? null,
          });
          return;
        }
        wakeFeed.deliver({
          reason: frame.reason ?? "",
          notification: frame.notification ?? "",
          conversationId,
        });
      },
    );

    // THE other death signal. These are unix-socket connections to a local
    // daemon: an unexpected close means the daemon died, and from that moment
    // every request on every connection rejects with "harness connection
    // closed" — including the ones that open sessions for new conversations.
    // Observed live: one crash and the sandbox served nothing again for the
    // rest of its life. A close WE initiated (dispose, a failed session
    // setup) is teardown, not death.
    connected.on("close", (error?: Error) => {
      clients.delete(connected);
      if (deliberateCloses.has(connected)) return;
      fail(error ? String(error) : "harness connection closed");
    });

    clients.add(connected);
    return connected;
  };

  return {
    id: "jcode",
    capabilities: {
      resume: true,
      thinking: true,
      toolEvents: true,
      // softInterrupt: a mid-run message joins the live turn at jcode's own
      // safe points — the same primitive its interactive composer uses.
      steer: true,
      skillsDir: ".agents/skills",
      instructionFiles: ["CLAUDE.md", "AGENTS.md"],
      // Connects to the platform-tools bridge at session start, and
      // discovers its tools asynchronously — so a starting session's first
      // turn is held until that listing arrives (see TOOL_LISTING_WAIT_MS).
      platformTools: true,
    },
    // The agent starts background work through jcode's OWN tooling by strong
    // reflex (proven live; and disabling that tooling is turn-fatal), so the
    // platform observes jcode's registry instead of fighting it — THREE feeds
    // through one seam: the bash background registry (jcode-background.ts),
    // the swarm-helper roster (jcode-swarm.ts), and the external wake
    // requests (jcode-wake.ts), each with its own format contract.
    backgroundTasks: mergeBackgroundTasks(
      createJcodeBackgroundTasks(),
      createJcodeSwarmTasks({
        legacySocketPath: () => legacySocketPath,
        leadRefs: () => [...sessionClients.keys()],
      }),
      wakeFeed,
    ),
    onFailure(listener) {
      onFailure = listener;
    },
    async startSession(options: StartSessionOptions) {
      let jcode: JcodeClient;
      try {
        jcode = await connectClient(options.homeDir);
      } catch (error) {
        // Launching the runtime is this adapter's whole reason to exist, and
        // a connect refused by a LOCAL daemon means that daemon is gone. If
        // it will not come up, the container can never serve a turn — and
        // failing only the turn would hide that behind an error the user is
        // invited to retry forever. Session-level failures on a live
        // connection (a stale resume ref, say) deliberately do not come
        // through here.
        fail(`harness launch failed: ${String(error)}`);
        throw error;
      }

      try {
        const resumeRef = options.resumeSessionRef;
        // ONE ref, one conversation. A resume ref held by a LIVE client in
        // this process is corrupted duplicate data — two conversations
        // persisted the same ref, which is exactly what the pre-fix
        // shared-session bug wrote to real installs. Never steal the live
        // session out from under its conversation (that would brick it for
        // the container's life): mint a FRESH session for the resumer
        // instead. Its new ref rides the next `turn.result` and heals the
        // duplication forward.
        const holder = resumeRef ? sessionClients.get(resumeRef) : undefined;
        if (resumeRef && holder) {
          log(
            "warn",
            "resume ref is held by a live conversation; minting fresh",
            {
              resumeSessionRef: resumeRef,
            },
          );
        }
        const session =
          resumeRef && !holder
            ? await jcode.attachSession(resumeRef)
            : await jcode.createSession(options.homeDir);

        const notices = await applyPreferences(
          jcode,
          session.session_id,
          options,
        );
        sessionClients.set(session.session_id, jcode);
        if (options.context) {
          sessionConversations.set(
            session.session_id,
            options.context.conversationId,
          );
        }
        return new JcodeSession(jcode, session.session_id, notices, () =>
          closeClient(jcode),
        );
      } catch (error) {
        // The connection exists but its session is unusable. Closing the
        // connection IS the detach (one attachment per connection) — without
        // it, every retry would leak a socket and a live attachment that
        // nothing will ever reach again.
        await closeClient(jcode);
        throw error;
      }
    },
    async dispose() {
      // Set BEFORE any close, because both teardown steps raise the very
      // signals that mean "the harness died" — every connection's `close`,
      // then the instance process's `exit` — and a deliberate teardown
      // reported as a failure would have the sandbox recycled on every
      // ordinary shutdown.
      disposing = true;
      await Promise.allSettled([...clients].map((c) => closeClient(c)));
      sessionClients.clear();
      sessionConversations.clear();
      if (instance) {
        const inst = await instance.catch(() => undefined);
        await inst?.shutdown();
        instance = undefined;
      }
      // After the shutdown, so the daemon's last lines (its own shutdown
      // trace) are drained by the follower's final poll.
      logForwarder?.stop();
      logForwarder = undefined;
    },
  };
};
