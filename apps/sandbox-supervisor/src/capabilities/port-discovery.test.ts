import { describe, expect, it } from "vitest";
import type { SupervisorMessage } from "@onecli/agent-protocol";
import {
  mergeListening,
  parseProcNetTcp,
  startPortDiscovery,
} from "./port-discovery";

// Real /proc/net/tcp shape (header + rows). 0050 = :80 on 0.0.0.0 (LISTEN),
// 1F90 = :8080 on 127.0.0.1 (LISTEN), 01BB = :443 ESTABLISHED (01, skipped).
const V4 = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1
   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2 1
   2: 0A2A50A6:D2F0 5F2B500A:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 3 1
`;
// :::3000 (all), ::1 port 5173 (loopback)
const V6 = `  sl  local_address                         remote_address                        st
   0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A
   1: 00000000000000000000000001000000:1435 00000000000000000000000000000000:0000 0A
`;

describe("port discovery", () => {
  it("parses LISTEN rows only", () => {
    expect(parseProcNetTcp(V4, "v4")).toEqual([80, 8080]);
    expect(parseProcNetTcp(V6, "v6")).toEqual([3000, 5173]);
  });

  it("skips binds on loopback addresses other than 127.0.0.1 (undialable, e.g. Docker's 127.0.0.11 resolver)", () => {
    // Seen live in a Docker sandbox: 0B00007F = 127.0.0.11 listening on a
    // random port. The supervisor dials 127.0.0.1 only, so it is no share.
    const table = `  sl  local_address rem_address   st
   0: 0B00007F:88F5 00000000:0000 0A
   1: 0100007F:1F90 00000000:0000 0A
`;
    expect(parseProcNetTcp(table, "v4")).toEqual([8080]);
  });

  it("tolerates garbage and empty tables", () => {
    expect(parseProcNetTcp("", "v4")).toEqual([]);
    expect(parseProcNetTcp("header\nnot a row\n  0: zz:qq 0 0A", "v4")).toEqual(
      [],
    );
  });

  it("merges families, dedupes, drops reserved ports, sorts", () => {
    const rows = [
      ...parseProcNetTcp(V4, "v4"),
      ...parseProcNetTcp(V6, "v6"),
      80,
    ];
    expect(mergeListening(rows, new Set([3000]))).toEqual([80, 5173, 8080]);
  });

  it("sends on change and re-sends unchanged state on the resend clock", async () => {
    const sent: SupervisorMessage[] = [];
    let v4 = V4;
    const d = startPortDiscovery({
      send: (m) => sent.push(m),
      pollMs: 60_000,
      resendMs: 0,
      readTable: async (f) => (f === "v4" ? v4 : ""),
    });
    await d.tick();
    await d.tick();
    expect(sent.length).toBeGreaterThanOrEqual(2); // resendMs=0 → every tick re-sends
    v4 = "";
    await d.tick();
    const lastMsg = sent.at(-1);
    expect(lastMsg?.kind === "ports.state" && lastMsg.ports).toEqual([]);
    d.stop();
  });

  it("does not re-send unchanged state before the resend window", async () => {
    const sent: SupervisorMessage[] = [];
    const d = startPortDiscovery({
      send: (m) => sent.push(m),
      pollMs: 60_000,
      resendMs: 60_000,
      readTable: async (f) => (f === "v4" ? V4 : ""),
    });
    await d.tick();
    await d.tick();
    await d.tick();
    expect(sent).toHaveLength(1);
    d.stop();
  });
});
