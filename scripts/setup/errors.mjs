// Failure with a way forward: every SetupError carries copy-pasteable hints,
// and the renderer always ends with the reassurance that progress is saved —
// the wizard's writes are idempotent, so re-running resumes, never restarts.

export class SetupError extends Error {
  /** @param {string} message @param {string[]} [hints] */
  constructor(message, hints = []) {
    super(message);
    this.name = "SetupError";
    this.hints = hints;
  }
}

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

export const renderFailure = (err) => {
  console.error(`\n${red("✗")} Setup failed`);
  console.error(`  ${err.message}`);
  if (err instanceof SetupError && err.hints.length) {
    console.error("\n  Try:");
    for (const hint of err.hints) console.error(`  • ${hint}`);
  }
  // An unexpected error is a bug — keep its stack visible.
  if (!(err instanceof SetupError) && err?.stack)
    console.error(`\n${dim(err.stack)}`);
  console.error(
    `\n${dim("Your progress is saved. Re-run `pnpm run setup` to pick up where you left off.")}\n`,
  );
};
