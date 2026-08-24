import { describe, expect, it } from "vitest";
import { machineFragment } from "./machine";

/**
 * The persistence contract the agent reads at turn 1. The wording pinned
 * here must stay consistent with the substrate's real behavior: the durable
 * set is the home volume (agent-entrypoint.sh, agent.Dockerfile), running
 * nested containers stop-not-die across sleep (/etc/containers/
 * README.onecli), and tracked background tasks report "lost" after a
 * restart (processes fragment).
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
