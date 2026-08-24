import { expect } from "vitest";
import { scenario } from "../src/scenario.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedOpenaiOauthGrant,
  seedTenant,
} from "../src/fixtures.js";
import { containerNameFor, dockerExec } from "../src/docker.js";
import { runTurn } from "../src/v1.js";

/**
 * The codex credential stub, end to end on the Docker substrate: an agent
 * granted an OpenAI OAuth secret gets `/home/node/.codex/auth.json` in its
 * spawn payload — a directory the agent image does NOT ship. The docker
 * backend must create the missing chain itself (Docker's archive endpoint
 * 404s on a missing extraction path; the Kata boot script isn't here to
 * `install -d`), and everything must land owned by the workload user: the
 * stub is mode 0600, so a root-owned copy is unreadable and Codex boots
 * credential-less.
 *
 * Before the fix this scenario cannot pass: the archive PUT 404s and the
 * sandbox reports start_failed on every attempt.
 */

scenario(
  "an OpenAI-OAuth grant boots: the codex stub lands node-owned in a created dir",
  async (cx) => {
    const stack = await cx.startStack();
    if (stack.runner === null) throw new Error("runner expected");
    await seedTenant(cx.prisma, cx.ids);
    await seedHostedAgent(cx.prisma, cx.ids, {
      runnerId: stack.runner.runnerId,
    });
    // Both providers, the shape that bit in the field: anthropic remains the
    // resolved model credential, and the openai OAuth secret INDEPENDENTLY
    // adds the codex stub to the payload.
    await seedAnthropicGrant(cx.prisma, cx.ids);
    await seedOpenaiOauthGrant(cx.prisma, cx.ids);
    stack.runner.pump();

    const conversation = await stack.v1.json<{ id: string }>(
      await stack.v1.put(`/v1/agents/${cx.ids.agent}/conversations/direct`),
    );
    const turn = await runTurn(stack.v1, conversation.id, "wake up");
    expect(turn.status).toBe("done");

    const container = containerNameFor(cx.ids.sandbox);

    // The stub and its created parent, owned by the workload user with the
    // payload's exact mode — `docker exec` runs as the container's pinned
    // `node` user, so the `cat` is a genuine readability proof, not a
    // root-can-read-anything one.
    const stubStat = await dockerExec(container, [
      "stat",
      "-c",
      "%u %g %a",
      "/home/node/.codex/auth.json",
    ]);
    expect(stubStat.stdout.trim()).toBe("1000 1000 600");
    const dirStat = await dockerExec(container, [
      "stat",
      "-c",
      "%u %g %a",
      "/home/node/.codex",
    ]);
    expect(dirStat.stdout.trim()).toBe("1000 1000 755");

    const stub = await dockerExec(container, [
      "cat",
      "/home/node/.codex/auth.json",
    ]);
    expect(JSON.parse(stub.stdout)).toMatchObject({ auth_mode: "chatgpt" });

    // CODEX_HOME pins Codex at the stub's directory — part of the container
    // env proper (not an entrypoint export), so exec sessions see it too.
    const env = await dockerExec(container, ["sh", "-c", "echo $CODEX_HOME"]);
    expect(env.stdout.trim()).toBe("/home/node/.codex");

    await stack.runner.pausePump();
  },
);
