// Which packages `pnpm dev` runs ON THE HOST — the one place that fact lives.
//
// `turbo run dev` runs the `dev` task of every package that defines one, so
// "does this package have a dev script?" silently decides what `pnpm dev`
// starts. That is how a container-only process once joined the host fan-out
// and took the whole stack down with it: the sandbox supervisor's `start`
// script was renamed to `dev` for the image build, and on a host (no
// `AGENT_HOME_DIR`) it defaults to `homeDir: "/workspace"`, cannot create it,
// and exits 1 — which aborts every other persistent dev task with it.
//
// So the fan-out is declared here and pinned by scripts/dev-fanout.test.mjs:
// CI never launches `pnpm dev`, so a test is the only thing standing between
// a renamed script and a broken dev command.

/** The services a developer expects `pnpm dev` to start. */
export const HOST_DEV_PACKAGES = [
  "@onecli/web",
  "@onecli/api-server",
  "@onecli/gateway",
  "@onecli/runner",
  "@onecli/channel-adapter",
  "@onecli/ssh-terminator",
];

/**
 * Packages whose process belongs to a CONTAINER, never to the host — the
 * runner spawns the supervisor inside the agent image, where `/workspace` is
 * a real mount. Excluded from the fan-out unconditionally, so re-adding a
 * `dev` script to one of them cannot break `pnpm dev` again. (An operator who
 * genuinely wants to run one on the host runs it in its own package with
 * `AGENT_HOME_DIR` set, not through the launcher.)
 */
export const NEVER_HOST_DEV_PACKAGES = ["@onecli/sandbox-supervisor"];

/** The turbo filters that keep the container-only packages out. */
export const devExcludeFilters = () =>
  NEVER_HOST_DEV_PACKAGES.map((name) => `--filter=!${name}`);
