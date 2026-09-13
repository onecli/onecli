import { describe, expect, it } from "vitest";
import { machineFragment } from "./machine";

/**
 * The persistence contract the agent reads at turn 1. The wording pinned
 * here must stay consistent with the substrate's real behavior: the durable
 * set is the home volume (agent-entrypoint.sh, agent.Dockerfile), running
 * nested containers stop-not-die across sleep (/etc/containers/
 * README.onecli), and tracked background tasks report "lost" after a
 * restart (processes fragment). Since the 2026-09-09 rewrite it is also the
 * INVENTORY contract: every tool named here is baked by agent.Dockerfile's
 * runner stage and gated at build, so a name here without a binary there
 * is a lie the agent will act on.
 */

describe("the machine fragment", () => {
  const flat = machineFragment.body.replace(/\s+/g, " ");

  it("names both durable roots — the volume and the POSIX home", () => {
    // MUTATION-PROOF: teaching only /workspace would leave the agent
    // believing ~ is ephemeral (the pre-change world); teaching only ~
    // would lose the workspace itself.
    expect(flat).toContain("/workspace");
    expect(flat).toContain("/workspace/.home");
  });

  it("teaches persistent installs and that apt does not survive", () => {
    expect(flat).toContain("npm install -g");
    expect(flat).toContain("pip install --user");
    expect(flat).toContain("~/.local");
    // apt lands on the ephemeral rootfs — the one install path that DOESN'T
    // persist must be named, or the agent learns it from a lost tool.
    expect(flat).toContain("apt");
  });

  it("says stopped containers are STARTED, never re-created", () => {
    // MUTATION-PROOF: without this the agent re-runs its database after
    // every sleep, orphaning the old container and its volume.
    expect(flat).toContain("podman start");
    expect(flat).toContain("do not re-create it");
  });

  it("defers container detail to the in-image README (one source, no drift)", () => {
    expect(flat).toContain("/etc/containers/README.onecli");
  });

  it("names the browser stack and defers its detail to the in-image README", () => {
    // MUTATION-PROOF: the failure this fragment was rewritten for — an agent
    // asked to browse said "no browser" four times while chromium sat at
    // /usr/bin. The binary path, the drivers, and the README (which carries
    // the proxy-credential snippet a browser here cannot work without) are
    // each load-bearing.
    expect(flat).toContain("/usr/bin/chromium");
    expect(flat).toContain("Playwright");
    expect(flat).toContain("ffmpeg");
    expect(flat).toContain("/etc/onecli/README.browser");
  });

  it("names the C toolchain so native-module installs are not mistaken for broken packages", () => {
    expect(flat).toContain("gcc");
    expect(flat).toContain("native npm and pip modules");
  });

  it("names Nix as the durable install path for what npm and pip lack, with its README", () => {
    // Tier 1.5. The one-time helper, the install verb, and the README (which
    // carries the CA re-export a fresh shell needs) are each load-bearing;
    // the hosted-only caveat keeps a self-hosted agent from chasing it.
    expect(flat).toContain("onecli-nix-install");
    expect(flat).toContain("nix profile add nixpkgs#");
    expect(flat).toContain("/etc/onecli/README.nix");
    expect(flat).toContain("Hosted agents only");
  });

  it("says nix is absent until the helper runs, so a failed probe leads to the helper", () => {
    // Observed live (prod, 2026-09-09): asked for a durable install, the
    // agent ran `which nix`, got nothing, and fetched a static binary from
    // GitHub — the helper was never tried. The rung must state the absence
    // and bind the failed probe to the helper, in that order.
    expect(flat).toContain("`nix` is NOT on this machine until you install it");
    expect(flat).toContain(
      "a failed `which nix` means run `onecli-nix-install`",
    );
    expect(flat).toContain("not pick another route");
  });

  it("marks the inventory as baked into the image, not apt-installed", () => {
    // The same agent called the image's ripgrep "from apt" — and the apt
    // sentence above says apt installs vanish, so it reasoned the baked tool
    // would too. The inventory must say where those tools come from.
    expect(flat).toContain("baked into the image, not from apt");
  });

  it("teaches that any public container image is an install path", () => {
    // The Slack-thread agent never considered `podman run <browser image>`;
    // the ladder must name containers as a way to GET tools, not only as a
    // thing that persists.
    expect(flat).toContain("Any public container image works too");
  });

  it("carries the try-before-saying-no rule", () => {
    // MUTATION-PROOF: drop either sentence and this fails. Discipline, not
    // enforcement — but it is the behavioral fix for a "hard environment
    // limit" declared after one failed `which`.
    expect(flat).toContain("Before telling anyone something cannot be done");
    expect(flat).toContain("Try at least one");
    expect(flat).toContain("say what you tried");
  });

  it('matches the processes fragment\'s restart wording ("lost")', () => {
    expect(flat).toContain('"lost"');
    expect(flat).toContain("Background processes above");
  });

  it("never names a runtime vendor", () => {
    // Same law as the platform prompt and the preamble: naming the runtime —
    // even to steer away from it — leaks the identity the platform withholds.
    expect(machineFragment.body).not.toMatch(/jcode/i);
  });
});
