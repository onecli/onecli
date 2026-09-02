import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { WorkItem } from "@onecli/agent-protocol";
import { createStdioTransport } from "./stdio";

describe("stdio transport", () => {
  it("yields valid work items, drops garbage, and ends on shutdown", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = createStdioTransport(input, output);

    input.write(
      '{"kind":"turn.deliver","turnId":"t1","conversationId":"cv1","message":"hi"}\n',
    );
    input.write("not json at all\n");
    input.write('{"kind":"nope"}\n');
    input.write('{"kind":"shutdown"}\n');
    input.write(
      '{"kind":"turn.deliver","turnId":"after","conversationId":"cv1","message":"x"}\n',
    );
    input.end();

    const items: WorkItem[] = [];
    for await (const item of transport.incoming()) items.push(item);

    expect(items).toEqual([
      {
        kind: "turn.deliver",
        turnId: "t1",
        conversationId: "cv1",
        message: "hi",
      },
      { kind: "shutdown" },
    ]);
  });

  it("writes supervisor messages as parseable JSONL", () => {
    const output = new PassThrough();
    const transport = createStdioTransport(new PassThrough(), output);

    transport.send({ kind: "ready", harness: "fake" });
    transport.send({
      kind: "event",
      turnId: "t1",
      conversationId: "cv1",
      event: { type: "text.delta", text: "hey" },
    });

    const lines = output.read()?.toString().trim().split("\n") ?? [];
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      kind: "ready",
      harness: "fake",
    });
    expect(JSON.parse(lines[1] ?? "")).toMatchObject({
      kind: "event",
      turnId: "t1",
    });
  });
});
