import { createInterface, type Interface } from "node:readline";
import {
  workItemSchema,
  type SupervisorMessage,
  type SupervisorTransport,
  type WorkItem,
} from "@onecli/agent-protocol";
import { log } from "../log";

/**
 * The stdio transport driver: JSONL work items on stdin, JSONL supervisor
 * messages on stdout. This is what `docker run -i` and the dev loop drive in
 * step 2; step 3 adds the WebSocket driver that dials the runner — behind
 * the same SupervisorTransport seam, so the supervisor loop never changes.
 *
 * stdout is protocol-only; anything human goes to stderr (see log.ts).
 */
export const createStdioTransport = (
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): SupervisorTransport => {
  let lines: Interface | undefined;
  let closed = false;

  return {
    async *incoming(): AsyncIterable<WorkItem> {
      if (closed) return;
      lines = createInterface({ input, crlfDelay: Infinity });
      for await (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          log("warn", "stdio transport: dropping non-JSON line");
          continue;
        }

        const item = workItemSchema.safeParse(parsed);
        if (!item.success) {
          log("warn", "stdio transport: dropping invalid work item", {
            issue: item.error.issues[0]?.message,
          });
          continue;
        }

        yield item.data;
        if (item.data.kind === "shutdown") return;
      }
    },
    send(message: SupervisorMessage): void {
      output.write(`${JSON.stringify(message)}\n`);
    },
    close(): Promise<void> {
      // Nothing to flush: `send` writes straight through. Ending the reader is
      // what releases stdin, so a supervisor driven over a pipe exits instead
      // of waiting on input nobody will send.
      closed = true;
      lines?.close();
      lines = undefined;
      return Promise.resolve();
    },
  };
};
