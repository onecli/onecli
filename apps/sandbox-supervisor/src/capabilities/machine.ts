import type { CapabilityFragment } from "../home/renderer";

/**
 * The machine capability — fragment-only, unconditional. Two contracts the
 * agent must hold from turn 1, and one rule of conduct:
 *
 * 1. WHAT SURVIVES. The durable set is exactly the home volume — /workspace,
 *    which contains the POSIX home (/workspace/.home; docker/agent-
 *    entrypoint.sh's contract). Everything else is the image and resets.
 *    An agent that does not hold this loses installed tools and re-pulls
 *    container images forever.
 * 2. WHAT IS HERE. The inventory of the agent image (docker/agent-base.Dockerfile
 *    plus docker/agent.Dockerfile's runner stage),
 *    named so the agent never says "no browser" while chromium sits at
 *    /usr/bin (the failure that motivated this rewrite, observed live:
 *    four consecutive "I can't" replies for a task the machine could do).
 *    The browser, Nix, and container bullets defer to root-owned in-image READMEs
 *    rather than re-teaching them (one source, no drift). What happens to
 *    background tasks on a restart is the processes fragment's fact alone
 *    (one home per rule); this fragment no longer repeats it.
 *    The sign-in bullet is the MECHANICS half of the system prompt's
 *    website-login exception (the LAW half: a login a person hands over for
 *    a browser task is theirs to give): the file-not-argv handoff, the
 *    delete-after, the saved session that spares the password on later
 *    turns, and the honest stop on 2FA/captcha/bot checks that big sites
 *    throw at headless browsers.
 *    The Nix rung says up front that `nix` is absent until the helper runs:
 *    observed live (prod, 2026-09-09), an agent asked for a durable install
 *    ran `which nix`, saw nothing, and fetched a static binary from GitHub
 *    instead — the helper was never tried because the probe came first.
 * 3. TRY BEFORE SAYING NO. Discipline, not enforcement: the agent has npm,
 *    pip, and any public container image at its disposal, and a "hard limit"
 *    declared after one `which` is almost always wrong.
 *
 * Vendor-name-free (pinned by the test): naming the runtime, even to steer
 * around it, leaks the identity the platform withholds.
 */
export const machineFragment: CapabilityFragment = {
  id: "machine",
  title: "Your machine",
  body: `Your machine is replaced routinely; its disk is not. Your working
directory /workspace — including your home directory ~ (/workspace/.home)
— survives sleep, restarts, and the machine being replaced. Everything
else resets: system directories, /tmp, and anything installed with apt
are gone after a restart.

What is installed (baked into the image, not from apt): node 22 (npm),
python 3 (pip, venv), git, ripgrep, curl, wget, jq, zip/unzip, ps, nano,
less, an ssh client, podman (with a \`docker\` CLI), chromium (headless
browser), ffmpeg, Xvfb, and a C toolchain (gcc, g++, make) so native npm
and pip modules build.

- Browsing and video: chromium is at /usr/bin/chromium. Install
  Playwright or Puppeteer (\`npm install -g playwright\`, or
  \`pip install --user playwright\`) and point it at that binary. Read
  /etc/onecli/README.browser FIRST: a browser here goes through the open
  proxy in $OPEN_PROXY (\`proxy: { server: process.env.OPEN_PROXY }\`),
  never the gateway proxy in HTTPS_PROXY, which is for APIs and CLIs. The
  README has the launch snippet and the sandbox flag for self-hosted
  deployments. Playwright records .webm natively; ffmpeg stitches frames.
- Signing in to a website with a login a person gave you: through the
  open proxy, pass it to your script through a file (never a command-line
  argument), delete the file once signed in, and save the session
  (Playwright \`storageState\`) under /workspace so later turns reuse it
  instead of the password. Some sites answer a browser from here with 2FA,
  a captcha, or a "verify you are human" box: try once with a visible
  window and a real cursor (README.browser, "Human checks"); if it stays,
  report that and stop rather than retrying.
- To install tools that persist, use \`npm install -g\` or
  \`pip install --user\` — both land under ~/.local, whose bin dir is on
  your PATH — or a venv / project node_modules under /workspace. Any
  public container image works too: \`podman run\` (or \`docker run\`)
  and its image stays on your disk. Never rely on an apt install
  surviving; re-run it after a restart instead.
- For a program that is not on npm or pip and should survive restarts,
  use Nix. \`nix\` is NOT on this machine until you install it — a
  failed \`which nix\` means run \`onecli-nix-install\` (once, a few
  seconds, offline), not pick another route. Then
  \`nix profile add nixpkgs#<name>\` for anything on search.nixos.org.
  Its store is on your disk and new shells have it on PATH. Read
  /etc/onecli/README.nix for the one line your CURRENT shell needs.
  Hosted agents only: on a self-hosted deployment the command says so.
- Container images, containers, and volumes persist, but running
  containers STOP when the machine sleeps: \`podman start\` (or
  \`docker start\`) the stopped container — do not re-create it, or you
  orphan its state. Details in /etc/containers/README.onecli.

Before telling anyone something cannot be done on this machine, check
for an npm or pip package, a container image, and the tools listed above.
Try at least one. If it still fails, say what you tried.`,
};
