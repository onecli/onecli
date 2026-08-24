#!/usr/bin/env node
// `pnpm run setup` — the interactive self-host front door.
//
// (`pnpm setup`, without `run`, is a pnpm built-in that has nothing to do
// with this repo — the docs always say `pnpm run setup`.)

import { parseArgs } from "node:util";

import { renderFailure, SetupError } from "./errors.mjs";

const HELP = `pnpm run setup: install and start OneCLI on this machine

Interactive by default. Flags for scripted runs:
  --yes               accept every default, ask nothing (required off-TTY)
  --mode=<m>          compose (published images) | source (build from this checkout)
  --no-runner         leave hosted agents off (no COMPOSE_PROFILES=runner)
  --channel-adapter   also enable the Slack channel adapter profile
  --external-url=<u>  the URL people open OneCLI at; every other address
                      derives from it (http means ports; https means a proxy)
  --bind=<host>       bind address for published ports (default: detected, never 0.0.0.0 by default)
  -h, --help          this text

The wizard maintains docker/.env: secrets are generated once and reused, and a
value you set is never overwritten. Re-run it any time.`;

const fail = (message) => {
  console.error(message);
  process.exit(2);
};

let parsed;
try {
  parsed = parseArgs({
    options: {
      yes: { type: "boolean", default: false },
      mode: { type: "string" },
      "no-runner": { type: "boolean", default: false },
      "channel-adapter": { type: "boolean", default: false },
      "external-url": { type: "string" },
      bind: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
} catch (err) {
  fail(`${err.message}\n\n${HELP}`);
}

const { values } = parsed;
if (values.help) {
  console.log(HELP);
  process.exit(0);
}
if (values.mode && !["compose", "source"].includes(values.mode))
  fail(`--mode must be compose or source (got "${values.mode}")\n\n${HELP}`);
if ((!process.stdout.isTTY || !process.stdin.isTTY) && !values.yes)
  fail(
    "No terminal to ask questions in. Pass --yes (plus --mode/--no-runner as needed) for a scripted run.",
  );

process.on("SIGINT", () => process.exit(130));

// A lazy import so a missing/failed install of the wizard's one dependency
// (@clack/prompts) produces an instruction, not a stack trace.
let runWizard;
try {
  ({ runWizard } = await import("./wizard.mjs"));
} catch (err) {
  if (
    err?.code === "ERR_MODULE_NOT_FOUND" &&
    /Cannot find (?:package|module) '[^./]/.test(err.message)
  )
    fail(
      "Setup dependencies are missing or out of date.\n\n  Run: pnpm install\n  Then retry: pnpm run setup",
    );
  throw err;
}

try {
  const { setAssumeYes } = await import("./ui.mjs");
  setAssumeYes(values.yes);
  await runWizard({
    yes: values.yes,
    mode: values.mode,
    noRunner: values["no-runner"],
    channelAdapter: values["channel-adapter"],
    externalUrl: values["external-url"],
    bind: values.bind,
  });
} catch (err) {
  renderFailure(err);
  process.exit(1);
}
