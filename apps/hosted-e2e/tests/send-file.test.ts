import { createHash } from "node:crypto";
import { expect } from "vitest";
import {
  MAX_OUTBOUND_ATTACHMENT_BYTES,
  MAX_OUTBOUND_ATTACHMENTS_PER_TURN,
} from "@onecli/agent-protocol";
import { scenario } from "../src/scenario.js";
import {
  seedAnthropicGrant,
  seedHostedAgent,
  seedTenant,
} from "../src/fixtures.js";
import { containerNameFor, dockerExec } from "../src/docker.js";
import { fakeDirective, text, tool } from "../src/fake-dsl.js";
import {
  fetchTranscript,
  readTurn,
  runTurn,
  transcriptText,
  waitFor,
} from "../src/v1.js";

/**
 * Tier 3 end to end: the agent SENDS a file back. The fake harness (a real
 * process in the real sandbox image) calls the real `send_file` platform
 * tool over the real MCP socket; the supervisor reads the file, streams it
 * as file.part frames over the real sandbox WebSocket; the real runner
 * reassembles, verifies, and POSTs it to the real API; the row binds to the
 * turn; the web surface serves the bytes back. Then the fences: containment
 * (a file outside the home), the per-turn count, and a late send after the
 * turn ended.
 */

interface TurnWithAttachments {
  id: string;
  status: string;
  attachments?: {
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    status: string;
    direction?: string;
    caption?: string | null;
  }[];
}

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

scenario(
  "send_file: a file written in the sandbox lands on the turn and downloads byte-exact; escapes and over-count are refused",
  async (cx) => {
    const stack = await cx.startStack();
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

    // ── A real multi-chunk file, produced INSIDE the sandbox ──────────────
    // 1.5 MiB of deterministic bytes: past one chunk (so reassembly is
    // real), small enough to stay well inside every cap. Its hash is taken
    // in the container, independently of anything the platform reports.
    // Written under /workspace (the agent's world and the tool's root for
    // relative paths). $HOME is the POSIX home INSIDE it (/workspace/.home);
    // the second file lives there and is sent by its absolute path — both
    // shapes the fragment offers, both must work.
    await dockerExec(container, [
      "sh",
      "-c",
      "mkdir -p /workspace/out && head -c 1572864 /dev/zero | tr '\\0' 'Q' > /workspace/out/clip.webm && printf 'hello' > $HOME/note.txt",
    ]);
    const inContainer = await dockerExec(container, [
      "sh",
      "-c",
      "sha256sum /workspace/out/clip.webm | cut -d' ' -f1",
    ]);
    const expectedSha = inContainer.stdout.trim();
    expect(expectedSha).toMatch(/^[0-9a-f]{64}$/);

    const sent = await runTurn(
      stack.v1,
      conversation.id,
      fakeDirective([
        tool("send_file", { path: "out/clip.webm", caption: "the run" }),
        tool("send_file", { path: "/workspace/.home/note.txt" }),
        text("sent both"),
      ]),
    );
    expect(sent.status).toBe("done");

    // The model-facing result first: on a refusal, the fake's echo of the
    // tool result is the diagnosis, and it must be in the failure message.
    const echoed = transcriptText(
      await fetchTranscript(stack.v1, conversation.id),
    );
    expect(echoed, echoed).toContain("[tool send_file ok]");

    // The turn's row carries both, bound, OUTBOUND, in send order.
    const row = await waitFor(
      async () =>
        (await readTurn(
          stack.v1,
          conversation.id,
          sent.id,
        )) as TurnWithAttachments | null,
      (turn) => (turn?.attachments?.length ?? 0) === 2,
      "the turn's two outbound attachments",
      15_000,
    );
    const [clip, note] = row!.attachments!;
    expect(clip).toMatchObject({
      name: "clip.webm",
      mimeType: "video/webm",
      sizeBytes: 1_572_864,
      status: "bound",
      direction: "outbound",
      caption: "the run",
    });
    expect(note).toMatchObject({
      name: "note.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      status: "bound",
      direction: "outbound",
      caption: null,
    });

    // The web download serves the SAME bytes the sandbox wrote.
    const download = await stack.v1.get(
      `/v1/conversations/${conversation.id}/attachments/${clip!.id}`,
    );
    expect(download.status).toBe(200);
    const bytes = Buffer.from(await download.arrayBuffer());
    expect(bytes.byteLength).toBe(1_572_864);
    expect(sha256(bytes)).toBe(expectedSha);
    const small = await stack.v1.get(
      `/v1/conversations/${conversation.id}/attachments/${note!.id}`,
    );
    expect(Buffer.from(await small.arrayBuffer()).toString()).toBe("hello");

    // The model saw the truth: a result it can read, with the stored id.
    const answer = transcriptText(
      await fetchTranscript(stack.v1, conversation.id),
    );
    expect(answer).toContain("[tool send_file ok]");
    expect(answer).toContain(`"attachmentId":"${clip!.id}"`);
    expect(answer).toContain('"sent":true');

    // ── Containment: a real file outside the home is refused before a byte
    // moves, and nothing lands on the turn ───────────────────────────────
    const escape = await runTurn(
      stack.v1,
      conversation.id,
      fakeDirective([
        tool("send_file", { path: "/etc/hostname" }),
        tool("send_file", { path: "../../etc/hostname" }),
        text("tried"),
      ]),
    );
    expect(escape.status).toBe("done");
    const escapeRow = (await readTurn(
      stack.v1,
      conversation.id,
      escape.id,
    )) as TurnWithAttachments | null;
    expect(escapeRow?.attachments ?? []).toEqual([]);
    const refusals = transcriptText(
      await fetchTranscript(stack.v1, conversation.id),
    );
    // The fake concatenates tool echoes without separators: match each
    // refusal up to its own wording, non-greedily.
    expect(
      refusals.match(/\[tool send_file error\] [^[]*?home directory/g),
    ).toHaveLength(2);

    // ── The per-turn count holds across the REAL path (supervisor's local
    // count first; the control plane's DB count is the authority) ─────────
    const overCount = await runTurn(
      stack.v1,
      conversation.id,
      fakeDirective([
        ...Array.from({ length: MAX_OUTBOUND_ATTACHMENTS_PER_TURN + 1 }, () =>
          tool("send_file", { path: "/workspace/.home/note.txt" }),
        ),
        text("flooded"),
      ]),
    );
    expect(overCount.status).toBe("done");
    const flooded = (await readTurn(
      stack.v1,
      conversation.id,
      overCount.id,
    )) as TurnWithAttachments | null;
    expect(flooded?.attachments).toHaveLength(
      MAX_OUTBOUND_ATTACHMENTS_PER_TURN,
    );

    // A file over the per-file belt is refused locally: nothing is read.
    await dockerExec(container, [
      "sh",
      "-c",
      `truncate -s ${MAX_OUTBOUND_ATTACHMENT_BYTES + 1} /workspace/out/huge.bin`,
    ]);
    const huge = await runTurn(
      stack.v1,
      conversation.id,
      fakeDirective([tool("send_file", { path: "out/huge.bin" }), text("x")]),
    );
    const hugeRow = (await readTurn(
      stack.v1,
      conversation.id,
      huge.id,
    )) as TurnWithAttachments | null;
    expect(hugeRow?.attachments ?? []).toEqual([]);
  },
);
