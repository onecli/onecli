import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect } from "vitest";
import { createDockerBackend } from "@onecli/runner/backend/docker";
import { installationFingerprint } from "@onecli/runner/installation";
import { scenario } from "../src/scenario.js";
import { seedTenant } from "../src/fixtures.js";

const exec = promisify(execFile);

/**
 * The stale-label orphan sweep against a REAL daemon (the unit tests prove
 * the logic on a fake backend; this proves the Engine API path), plus the
 * Tier-C egress fail-closed check — the one runner safety property only a
 * real network object can exercise.
 */

const MANAGED = "sh.onecli.managed=1";

scenario(
  "the sweep reaps a dead runner's leftovers, spares the known",
  async (cx) => {
    const ghostSandboxId = `he2e-${cx.ids.nonce}-ghost`;
    const ghostContainer = `onecli-sandbox-${ghostSandboxId}`;
    const ghostVolume = `onecli-home-${ghostSandboxId}`;
    const labels = [
      `--label=${MANAGED}`,
      `--label=sh.onecli.sandbox-id=${ghostSandboxId}`,
      `--label=sh.onecli.runner-id=r-dead-${cx.ids.nonce}`,
      // THIS install, dead runner id — the canonical orphan (a DB reset
      // minted a fresh runner id but the token, hence the fingerprint, held).
      `--label=sh.onecli.installation=${installationFingerprint(cx.ids.runnerToken)}`,
    ];
    // Plant the corpse a dead runner id left behind: a created-never-started
    // container and its home volume, both platform-labeled.
    await exec("docker", ["volume", "create", ...labels, ghostVolume]);
    await exec("docker", [
      "create",
      `--name=${ghostContainer}`,
      ...labels,
      cx.config.agentImage,
      "true",
    ]);

    const stack = await cx.startStack({ orphanGraceSeconds: 1 });
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);

    // Give the grace second a moment to pass, then run the sweep by hand.
    await new Promise((r) => setTimeout(r, 1_500));
    await stack.runner.reconcile();

    const container = await exec("docker", ["inspect", ghostContainer]).then(
      () => "present",
      () => "gone",
    );
    const volume = await exec("docker", [
      "volume",
      "inspect",
      ghostVolume,
    ]).then(
      () => "present",
      () => "gone",
    );
    expect(container).toBe("gone");
    expect(volume).toBe("gone");
  },
);

scenario(
  "a KNOWN sandbox id is never reaped, whoever's label it carries",
  async (cx) => {
    const stack = await cx.startStack({ orphanGraceSeconds: 1 });
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);

    // A volume labeled by a FOREIGN runner id, but whose sandbox id EXISTS in
    // the control plane (a live sibling's row) — the existence check must
    // spare it. Seed the row first, authority before objects.
    const siblingSandboxId = `he2e-${cx.ids.nonce}-sibling`;
    await cx.prisma.agent.create({
      data: {
        id: `${cx.ids.agent}-sib`,
        workspaceId: cx.ids.workspace,
        name: "sibling",
        identifier: `${cx.ids.agent}-sib`,
        accessToken: `${cx.ids.agentToken}sib`,
        kind: "hosted",
        harness: "fake",
      },
    });
    await cx.prisma.sandbox.create({
      data: {
        id: siblingSandboxId,
        agentId: `${cx.ids.agent}-sib`,
        runnerId: stack.runner.runnerId,
        status: "unprovisioned",
      },
    });
    const siblingVolume = `onecli-home-${siblingSandboxId}`;
    await exec("docker", [
      "volume",
      "create",
      `--label=${MANAGED}`,
      `--label=sh.onecli.sandbox-id=${siblingSandboxId}`,
      `--label=sh.onecli.runner-id=r-someone-else`,
      // THIS install — so it is spared for the RIGHT reason (the control
      // plane knows the id), not merely by the installation fence.
      `--label=sh.onecli.installation=${installationFingerprint(cx.ids.runnerToken)}`,
      siblingVolume,
    ]);

    await new Promise((r) => setTimeout(r, 1_500));
    await stack.runner.reconcile();

    const volume = await exec("docker", [
      "volume",
      "inspect",
      siblingVolume,
    ]).then(
      () => "present",
      () => "gone",
    );
    expect(volume).toBe("present");
    await exec("docker", ["volume", "rm", "-f", siblingVolume]).catch(() => {});
  },
);

scenario(
  "a DIFFERENT install's live object is NEVER reaped (shared-daemon safety)",
  async (cx) => {
    // The regression the review caught: on a shared daemon, another install's
    // object has a foreign runner id AND a sandbox id this control plane has
    // never heard of — every fence except the installation fingerprint would
    // pass. Plant one with a foreign installation label; it must survive.
    const foreignSandboxId = `he2e-${cx.ids.nonce}-foreign`;
    const foreignVolume = `onecli-home-${foreignSandboxId}`;
    await exec("docker", [
      "volume",
      "create",
      `--label=${MANAGED}`,
      `--label=sh.onecli.sandbox-id=${foreignSandboxId}`,
      `--label=sh.onecli.runner-id=r-other-install`,
      `--label=sh.onecli.installation=${installationFingerprint("rnr_some-other-install")}`,
      foreignVolume,
    ]);

    const stack = await cx.startStack({ orphanGraceSeconds: 1 });
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);

    await new Promise((r) => setTimeout(r, 1_500));
    await stack.runner.reconcile();

    const volume = await exec("docker", [
      "volume",
      "inspect",
      foreignVolume,
    ]).then(
      () => "present",
      () => "gone",
    );
    expect(volume).toBe("present");
    await exec("docker", ["volume", "rm", "-f", foreignVolume]).catch(() => {});
  },
);

scenario(
  "Tier C: the runner refuses a non-internal network it expected internal",
  async (cx) => {
    const rogueNetwork = `${cx.ids.network}-rogue`;
    await exec("docker", ["network", "create", rogueNetwork]); // NOT internal
    try {
      const backend = createDockerBackend({
        runnerId: "tier-c",
        installationId: "tier-c",
        network: rogueNetwork,
        networkInternal: true,
        socketPath: cx.config.dockerSocket,
      });
      await expect(backend.prepare()).rejects.toThrow(/NOT internal/);
    } finally {
      await exec("docker", ["network", "rm", rogueNetwork]).catch(() => {});
    }
  },
);
