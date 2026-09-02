// Argument handling for `pnpm dev` — small and separate because pnpm's `--`
// forwarding is subtle enough to deserve a test.

/**
 * pnpm forwards a literal `--` to the script (`pnpm dev -- --filter=x` gives
 * us ["--", "--filter=x"]), but turbo treats everything after `--` as
 * pass-through TASK arguments, not its own flags — so a kept `--` would make
 * turbo hand `--filter=x` to every dev server instead of filtering. Strip one
 * leading `--`; both `pnpm dev --filter=x` and `pnpm dev -- --filter=x` then
 * mean the same thing.
 *
 * `userFiltered` is true when the user picked services themselves (any turbo
 * filter spelling) — the launcher then owns neither service selection nor the
 * runner checks.
 */
export const normalizeDevArgs = (argv) => {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const userFiltered = args.some(
    (a) => a === "-F" || a.startsWith("-F=") || a.startsWith("--filter"),
  );
  return { args, userFiltered };
};
