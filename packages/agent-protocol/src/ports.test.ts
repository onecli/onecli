import { describe, expect, it } from "vitest";
import { runnerEventSchema } from "./runner-wire";
import {
  MAX_LISTENING_PORTS_WIRE,
  PORT_CHUNK_BASE64_CHARS,
  PORT_CHUNK_RAW_BYTES,
  PORT_STREAM_WINDOW_BYTES,
  supervisorMessageSchema,
  workItemSchema,
} from "./transport";

/**
 * Sandbox ports wire (plans/sandbox-ports.md §7). The frame bounds are the
 * load-bearing part: a legal max-size data frame must stay far under the
 * runner WS's 256KB drop-whole ceiling, and anything larger must be refused
 * by validation rather than silently dropped by the socket.
 */
describe("sandbox ports frames", () => {
  const maxChunk = Buffer.alloc(PORT_CHUNK_RAW_BYTES, 7).toString("base64");

  it("a max raw chunk encodes to exactly the base64 bound", () => {
    expect(maxChunk.length).toBe(PORT_CHUNK_BASE64_CHARS);
  });

  it("a max-size data frame serializes well under 256KB", () => {
    const frame = {
      kind: "port.data",
      streamId: "s".repeat(64),
      dataBase64: maxChunk,
    };
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(128 * 1024);
    expect(workItemSchema.safeParse(frame).success).toBe(true);
    expect(supervisorMessageSchema.safeParse(frame).success).toBe(true);
  });

  it("refuses an oversized data chunk on both directions", () => {
    const tooBig = maxChunk + "AAAA";
    expect(
      workItemSchema.safeParse({
        kind: "port.data",
        streamId: "a",
        dataBase64: tooBig,
      }).success,
    ).toBe(false);
    expect(
      supervisorMessageSchema.safeParse({
        kind: "port.data",
        streamId: "a",
        dataBase64: tooBig,
      }).success,
    ).toBe(false);
  });

  it("refuses non-base64 bytes and empty data", () => {
    for (const dataBase64 of ["not base64!", ""]) {
      expect(
        workItemSchema.safeParse({
          kind: "port.data",
          streamId: "a",
          dataBase64,
        }).success,
      ).toBe(false);
    }
  });

  it("bounds ports and stream ids", () => {
    expect(
      workItemSchema.safeParse({ kind: "port.open", streamId: "a", port: 8080 })
        .success,
    ).toBe(true);
    for (const port of [0, 65_536, 80.5, -1]) {
      expect(
        workItemSchema.safeParse({ kind: "port.open", streamId: "a", port })
          .success,
      ).toBe(false);
    }
    expect(
      workItemSchema.safeParse({
        kind: "port.open",
        streamId: "x".repeat(65),
        port: 80,
      }).success,
    ).toBe(false);
  });

  it("bounds ack grants to the window", () => {
    const ok = {
      kind: "port.ack",
      streamId: "a",
      bytes: PORT_STREAM_WINDOW_BYTES,
    };
    expect(workItemSchema.safeParse(ok).success).toBe(true);
    expect(
      workItemSchema.safeParse({ ...ok, bytes: PORT_STREAM_WINDOW_BYTES + 1 })
        .success,
    ).toBe(false);
    expect(workItemSchema.safeParse({ ...ok, bytes: 0 }).success).toBe(false);
  });

  it("error codes are a closed vocabulary", () => {
    for (const code of [
      "not_allowed",
      "not_listening",
      "limit",
      "duplicate",
      "failed",
    ]) {
      expect(
        supervisorMessageSchema.safeParse({
          kind: "port.error",
          streamId: "a",
          code,
        }).success,
      ).toBe(true);
    }
    expect(
      supervisorMessageSchema.safeParse({
        kind: "port.error",
        streamId: "a",
        code: "nope",
      }).success,
    ).toBe(false);
  });

  it("ports.allow and ports.state carry bounded port lists", () => {
    expect(
      workItemSchema.safeParse({ kind: "ports.allow", ports: [80, 8080] })
        .success,
    ).toBe(true);
    expect(
      supervisorMessageSchema.safeParse({ kind: "ports.state", ports: [80] })
        .success,
    ).toBe(true);
    expect(
      supervisorMessageSchema.safeParse({ kind: "ports.state", ports: [0] })
        .success,
    ).toBe(false);
    expect(
      supervisorMessageSchema.safeParse({
        kind: "ports.state",
        ports: Array.from(
          { length: MAX_LISTENING_PORTS_WIRE + 1 },
          (_, i) => i + 1,
        ),
      }).success,
    ).toBe(false);
  });

  it("sandbox.ports is a runner event stamped with the sandbox and container", () => {
    expect(
      runnerEventSchema.safeParse({
        kind: "sandbox.ports",
        sandboxId: "sbx",
        containerRef: "ctr",
        ports: [80, 8080],
      }).success,
    ).toBe(true);
    // The stamps are the runner's authenticated facts, never optional.
    expect(
      runnerEventSchema.safeParse({
        kind: "sandbox.ports",
        sandboxId: "sbx",
        ports: [80],
      }).success,
    ).toBe(false);
  });
});
