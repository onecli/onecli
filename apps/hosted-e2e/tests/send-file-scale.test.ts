import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import {
  MAX_OUTBOUND_ATTACHMENT_BYTES,
  MAX_OUTBOUND_ATTACHMENT_BYTES_PER_CONVERSATION_DAY,
  MAX_OUTBOUND_ATTACHMENTS_PER_TURN,
  RUNNER_ATTACHMENT_HEADERS,
} from "@onecli/agent-protocol";
import { scenario } from "../src/scenario.js";
import { seedTenant } from "../src/fixtures.js";

/**
 * SCALE, the door only: N sandboxes each sending the per-turn maximum of
 * maximum-size files AT ONCE through the real api child (route → header
 * schema → capped stream → fence query → sha → row → pg blob store → daily
 * aggregate). No containers: the runner's relay is a thin POST, and the
 * question here is whether the CONTROL PLANE holds 2.5 GB of concurrent
 * uploads without falling over or ballooning. Asserts: every upload lands
 * (or is refused only by the daily budget, honestly), the api child's RSS
 * stays bounded, and the bytes read back intact.
 *
 * Opt-in (HOSTED_E2E_SCALE=1): it moves gigabytes through a laptop's
 * loopback and takes a minute; the default suite must stay fast. Opted out
 * it registers as SKIPPED, never as an empty file — vitest fails a file with
 * no tests, which would fail every default run.
 */

const SANDBOXES = 10;
const FILES_PER_TURN = MAX_OUTBOUND_ATTACHMENTS_PER_TURN;
const FILE_BYTES = MAX_OUTBOUND_ATTACHMENT_BYTES;
const exec = promisify(execFile);

const rssMb = async (pid: number): Promise<number> => {
  const { stdout } = await exec("ps", ["-o", "rss=", "-p", String(pid)]);
  return Math.round(Number(stdout.trim()) / 1024);
};

const SCALE_NAME = `SCALE: ${SANDBOXES} sandboxes × ${FILES_PER_TURN} × 25MB concurrent uploads through the real api`;

if (process.env.HOSTED_E2E_SCALE !== "1") {
  test.skip(`${SCALE_NAME} (set HOSTED_E2E_SCALE=1)`, () => undefined);
} else {
  scenario(SCALE_NAME, async (cx) => {
    const stack = await cx.startStack({ withRunner: false });
    await seedTenant(cx.prisma, cx.ids);
    const runner = await cx.prisma.runner.create({
      data: {
        id: `${cx.ids.nonce}-runner`,
        name: "scale-runner",
        token: cx.ids.runnerToken,
      },
      select: { id: true },
    });

    // N agents, each with a sandbox on this runner, one running turn.
    const targets: {
      sandboxId: string;
      conversationId: string;
      turnId: string;
    }[] = [];
    for (let i = 0; i < SANDBOXES; i += 1) {
      const agent = await cx.prisma.agent.create({
        data: {
          workspaceId: cx.ids.workspace,
          name: `scale-${i}`,
          identifier: `${cx.ids.nonce}-scale-${i}`,
          accessToken: `aoc_${cx.ids.nonce}_${i}`,
          kind: "hosted",
          harness: "fake",
          sandbox: {
            create: {
              id: `${cx.ids.nonce}-sbx-${i}`,
              runnerId: runner.id,
              status: "running",
            },
          },
        },
        select: { id: true },
      });
      const conversation = await cx.prisma.conversation.create({
        data: { agentId: agent.id, source: "web", title: "scale" },
        select: { id: true },
      });
      const turn = await cx.prisma.turn.create({
        data: {
          conversationId: conversation.id,
          message: "send everything",
          status: "running",
          userId: cx.ids.user,
        },
        select: { id: true },
      });
      targets.push({
        sandboxId: `${cx.ids.nonce}-sbx-${i}`,
        conversationId: conversation.id,
        turnId: turn.id,
      });
    }

    // One 25 MB body, reused (the api hashes what it receives; identical
    // content across uploads is fine — rows are per file, not per hash).
    const body = Buffer.alloc(FILE_BYTES, 0x51);
    const sha = createHash("sha256").update(body).digest("hex");
    const upload = (t: (typeof targets)[number], i: number) =>
      fetch(`${stack.api.origin}/v1/runner/attachments`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${cx.ids.runnerToken}`,
          "content-type": "application/octet-stream",
          [RUNNER_ATTACHMENT_HEADERS.sandboxId]: t.sandboxId,
          [RUNNER_ATTACHMENT_HEADERS.conversationId]: t.conversationId,
          [RUNNER_ATTACHMENT_HEADERS.turnId]: t.turnId,
          [RUNNER_ATTACHMENT_HEADERS.name]: encodeURIComponent(`part-${i}.bin`),
          [RUNNER_ATTACHMENT_HEADERS.sha256]: sha,
        },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(120_000),
      }).then(async (res) => ({
        status: res.status,
        json: (await res.json()) as {
          ok: boolean;
          attachmentId?: string;
          error?: string;
        },
      }));

    const pid = stack.api.service.child.pid!;
    const before = await rssMb(pid);
    const started = Date.now();
    // Everything at once: 100 requests, 2.5 GB in flight.
    const results = await Promise.all(
      targets.flatMap((t) =>
        Array.from({ length: FILES_PER_TURN }, (_, i) => upload(t, i)),
      ),
    );
    const elapsedMs = Date.now() - started;
    const peakish = await rssMb(pid);

    const ok = results.filter((r) => r.json.ok);
    const refused = results.filter((r) => !r.json.ok);
    // The daily budget (200 MB per conversation) is smaller than a full
    // turn of maximum files (250 MB): the overflow must be refused by the
    // budget, honestly, and nothing else may fail. 8 land, 2 refuse, per
    // sandbox — the order is a race, the COUNTS are the law.
    const perConversationLanding = Math.floor(
      MAX_OUTBOUND_ATTACHMENT_BYTES_PER_CONVERSATION_DAY / FILE_BYTES,
    );
    const tally = new Map<string, number>();
    for (const r of results) {
      const key = `${r.status} ${r.json.ok ? "ok" : (r.json.error ?? "?")}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    console.log("scale tally:", Object.fromEntries(tally));
    expect(
      results.every((r) => r.status === 200),
      JSON.stringify([...tally]),
    ).toBe(true);
    expect(ok, JSON.stringify([...tally])).toHaveLength(
      SANDBOXES * perConversationLanding,
    );
    expect(refused).toHaveLength(
      SANDBOXES * (FILES_PER_TURN - perConversationLanding),
    );
    expect(refused.every((r) => /daily limit/.test(r.json.error ?? ""))).toBe(
      true,
    );

    // Bytes intact: one row per sandbox read back through the store.
    const rows = await cx.prisma.conversationAttachment.findMany({
      where: { direction: "outbound" },
      select: { id: true, sizeBytes: true, sha256: true },
    });
    expect(rows).toHaveLength(ok.length);
    expect(
      rows.every((r) => r.sizeBytes === FILE_BYTES && r.sha256 === sha),
    ).toBe(true);

    // The api child must not have buffered the fleet: 100 × 25 MB bodies
    // arriving together is 2.5 GB of wire; a process that held even a
    // third of that would be a leak. Generous belt, honest number logged.
    console.log(
      `scale: ${ok.length} landed, ${refused.length} budget-refused, ${elapsedMs}ms, api rss ${before}MB → ${peakish}MB`,
    );
    expect(peakish - before).toBeLessThan(1_200);
  });
}
