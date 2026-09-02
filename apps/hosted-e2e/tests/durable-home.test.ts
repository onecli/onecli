import { expect } from "vitest";
import { scenario } from "../src/scenario.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import { containerNameFor, dockerExec } from "../src/docker.js";
import { runTurn, waitFor } from "../src/v1.js";

/**
 * The durable POSIX home, end to end on the Docker substrate: ~ lives at
 * /workspace/.home ON the home volume (passwd entry + entrypoint create/seed
 * + the unified npm/pip prefix on PATH), so a tool installed there survives
 * the container being REPLACED — the runner recreates on every start, which
 * is exactly the relaunch the old /home/node home never survived. The plant
 * is a file dropped into ~/.local/bin rather than a real `npm i -g`
 * (registry egress is not a given here); the persistence and PATH contract
 * it proves is identical.
 */

scenario(
  "~ is durable: a tool in ~/.local/bin survives park and wake",
  async (cx) => {
    const stack = await cx.startStack({
      // 5s, not 1s: pausePump() below only awaits the CURRENT wait=1s poll,
      // and a poll issued just before a turn is observed done re-claims once
      // more ~1.3s after the idle clock last reset (250ms observation gap +
      // the 1s poll wait). A 1s window lets that straggler claim the stop
      // AFTER the pause resolves; 5s puts it deterministically out of reach,
      // while the 60s park waitFor absorbs the longer wait.
      apiEnv: { SANDBOX_IDLE_STOP_SECONDS: "5" },
    });
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, {
      runnerId: stack.runner.runnerId,
    });
    await seedAnthropicGrant(cx.prisma, cx.ids);
    stack.runner.pump();

    const conversation = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );
    const boot = await runTurn(stack.v1, conversation.id, "wake up");
    expect(boot.status).toBe("done");

    const container = containerNameFor(cx.ids.sandbox);

    // A live pump would claim the idle stop out from under the execs below
    // (npm alone can eat most of a second cold; docker exec then dies with
    // 137 — a live CI flake). Park is what this scenario wants, but only
    // AFTER the inspection and the plant, so hold the pump — the runner,
    // not the API, performs the stop. Airtight only together with the 5s
    // idle window above: the pause cannot cancel an already-issued poll,
    // just outwait it.
    await stack.runner.pausePump();

    // Identity: HOME comes from the image's passwd entry (usermod), and the
    // entrypoint created + skel-seeded it and pre-created the tool bin.
    const home = await dockerExec(container, ["sh", "-c", "echo $HOME"]);
    expect(home.stdout.trim()).toBe("/workspace/.home");
    await dockerExec(container, [
      "sh",
      "-c",
      "test -d /workspace/.home/.local/bin && test -f /workspace/.home/.bashrc && test -f /workspace/.home/.profile",
    ]);

    // The unified install root: npm's global prefix rides the baked env, and
    // a LOGIN shell (the SSH door's shape — /etc/profile resets PATH, the
    // profile.d drop-in re-appends) still sees the durable bin dir.
    const prefix = await dockerExec(container, [
      "npm",
      "config",
      "get",
      "prefix",
    ]);
    expect(prefix.stdout.trim()).toBe("/workspace/.home/.local");
    const loginPath = await dockerExec(container, [
      "bash",
      "-lc",
      "echo :$PATH:",
    ]);
    expect(loginPath.stdout).toContain(":/workspace/.home/.local/bin:");

    // Plant the tool — the artifact a `pip install --user` / `npm i -g`
    // would land in the same directory — and an agent edit to a seeded
    // dotfile, which a reseeding wake would silently revert.
    await dockerExec(container, [
      "sh",
      "-c",
      "printf '#!/bin/sh\\necho tool-survived' > /workspace/.home/.local/bin/he2e-tool && chmod +x /workspace/.home/.local/bin/he2e-tool && echo '# agent-edit' >> /workspace/.home/.bashrc",
    ]);

    // Let the pump run again: once the idle window lapses its poll claims
    // the stop — the container is stopped and replaced at the next wake
    // (recreate-on-start), only the volume carries state across.
    stack.runner.pump();
    await waitFor(
      () => cx.prisma.sandbox.findUnique({ where: { id: cx.ids.sandbox } }),
      (sandbox) => sandbox?.status === "stopped",
      "sandbox to park",
    );

    // Wake into a FRESH container (recreate-on-start): the tool must resolve
    // by bare name through the login-shell PATH, off the surviving volume.
    const second = await runTurn(stack.v1, conversation.id, "and again");
    expect(second.status).toBe("done");
    // Same fence as above: the second turn restarted the idle clock, and
    // the fresh container must survive these inspections too. dockerExec
    // talks straight to Docker, so nothing below needs the pump.
    await stack.runner.pausePump();
    const rerun = await dockerExec(container, ["bash", "-lc", "he2e-tool"]);
    expect(rerun.stdout.trim()).toBe("tool-survived");
    // Seed-once: the wake found an existing ~ and must NOT have re-seeded
    // the dotfiles over the agent's edit.
    const bashrc = await dockerExec(container, [
      "sh",
      "-c",
      "grep -c '# agent-edit' /workspace/.home/.bashrc",
    ]);
    expect(bashrc.stdout.trim()).toBe("1");
  },
);
