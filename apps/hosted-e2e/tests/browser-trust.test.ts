import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
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
 * Chromium trusts the gateway CA, end to end on the Docker substrate. Every
 * other TLS client in the sandbox trusts the MITM CA through env vars
 * (SSL_CERT_FILE, NODE_EXTRA_CA_CERTS…); chromium on Linux reads only the
 * NSS shared DB, so agent-entrypoint.sh imports the delivered CA into
 * ~/.pki/nssdb at every boot. This proves the boot path against the REAL
 * spawn: the CA the runner materialised at /tmp/onecli-gateway-ca.pem is the
 * one in the DB (nickname carries its fingerprint), trusted for TLS server
 * auth only ("C,,"), exactly once — and a relaunch onto the same home (park
 * + wake = recreate-on-start) finds it and adds nothing. The handshake
 * itself — chromium loading a page signed by an NSS-imported CA with no
 * ignore flag — is the image's build gate (agent.Dockerfile), where it runs
 * without needing egress.
 */

/** The entrypoint's nickname suffix: first 16 hex of the CA's SHA-256. */
const fingerprintPrefix = (pem: string): string =>
  createHash("sha256")
    .update(new X509Certificate(pem).raw)
    .digest("hex")
    .toUpperCase()
    .slice(0, 16);

const LIST_GATEWAY_ENTRIES =
  "certutil -d sql:$HOME/.pki/nssdb -L | awk '$1 ~ /^onecli-gateway-/ {print $1, $2}'";

scenario(
  "chromium trusts the gateway CA: imported into ~/.pki/nssdb at boot, once, and again after a relaunch",
  async (cx) => {
    const stack = await cx.startStack({
      // Same fence as durable-home.test.ts: a 5s idle window keeps a
      // straggler poll from claiming the stop before pausePump() resolves.
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
    await stack.runner.pausePump();

    // The nickname must carry the fingerprint of the GATEWAY's CA, computed
    // here from the gateway's own file — proving the entry is the delivered
    // CA and not some other certificate that happened to be imported.
    const expectedNick = `onecli-gateway-${fingerprintPrefix(
      readFileSync(stack.gateway.caPath, "utf8"),
    )}`;

    // Exactly one gateway entry, ours, trusted for TLS server auth only.
    const first = await dockerExec(container, [
      "sh",
      "-c",
      LIST_GATEWAY_ENTRIES,
    ]);
    expect(first.stdout.trim().split("\n")).toEqual([`${expectedNick} C,,`]);

    // Park and wake into a FRESH container on the same volume: the second
    // boot must find the entry and add nothing (idempotency on a real
    // second boot, not a re-run in the same process).
    stack.runner.pump();
    await waitFor(
      () => cx.prisma.sandbox.findUnique({ where: { id: cx.ids.sandbox } }),
      (sandbox) => sandbox?.status === "stopped",
      "sandbox to park",
    );
    const second = await runTurn(stack.v1, conversation.id, "and again");
    expect(second.status).toBe("done");
    await stack.runner.pausePump();
    const after = await dockerExec(container, [
      "sh",
      "-c",
      LIST_GATEWAY_ENTRIES,
    ]);
    expect(after.stdout.trim().split("\n")).toEqual([`${expectedNick} C,,`]);
  },
);
