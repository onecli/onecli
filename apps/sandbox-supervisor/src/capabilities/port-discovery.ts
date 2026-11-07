import { readFile } from "node:fs/promises";
import {
  MAX_LISTENING_PORTS_WIRE,
  type SupervisorMessage,
} from "@onecli/agent-protocol";
import { log } from "../log";

/**
 * Port discovery (plans/sandbox-ports.md §7): which TCP ports are listening
 * in the guest, so the UI can offer "8080 is listening — share it?".
 *
 * Source of truth is the guest kernel (`/proc/net/tcp{,6}`, state 0A =
 * LISTEN) — it covers plain processes AND podman-published ports (pasta binds
 * the published port on the guest), with no dependency on podman itself.
 * Verified live in a hosted sandbox: a container published with `-p 80:80`
 * appears as a LISTEN row on :80.
 *
 * Reliability follows the process.state law: send on change, and re-send on
 * a slow clock because the channel cannot reconnect (single-use token), so a
 * dropped frame is only ever healed by the next re-send.
 */

const LISTEN_STATE = "0A";

/** Parse one /proc/net/tcp{,6} table into listening ports. Exported for tests. */
export const parseProcNetTcp = (
  table: string,
  family: "v4" | "v6",
): number[] => {
  const out: number[] = [];
  for (const line of table.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || cols[3] !== LISTEN_STATE) continue;
    const [addrHex, portHex] = (cols[1] ?? "").split(":");
    if (!addrHex || !portHex) continue;
    const port = parseInt(portHex, 16);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) continue;
    // The supervisor dials 127.0.0.1 only. A bind on ANOTHER loopback
    // address (127.0.0.11 is the Docker embedded resolver, for one) can
    // never be served, so offering it in the UI would be a dead share.
    // (/proc stores v4 addresses little-endian: the last byte pair is the
    // first octet.)
    if (
      family === "v4" &&
      addrHex.length === 8 &&
      addrHex.slice(6, 8).toUpperCase() === "7F" &&
      addrHex.toUpperCase() !== "0100007F"
    )
      continue;
    out.push(port);
  }
  return out;
};

/** Merge v4+v6 rows: unique, sorted, platform ports dropped, wire-capped. */
export const mergeListening = (
  ports: number[],
  reserved: ReadonlySet<number>,
): number[] =>
  [...new Set(ports)]
    .filter((port) => !reserved.has(port))
    .sort((a, b) => a - b)
    .slice(0, MAX_LISTENING_PORTS_WIRE);

export interface PortDiscoveryOptions {
  send: (message: SupervisorMessage) => void;
  /** Platform ports never reported (the supervisor's own listeners). */
  reservedPorts?: ReadonlySet<number>;
  /** Poll cadence for change detection. */
  pollMs?: number;
  /** Unconditional re-send cadence (the re-send law). */
  resendMs?: number;
  /**
   * Other slow-clock reports that ride the SAME re-send beat (the desktop's
   * viewable flag): one timer for every "re-sent because the supervisor
   * cannot reconnect" message, not one per capability.
   */
  onResend?: () => void;
  /** Test seam. */
  readTable?: (family: "v4" | "v6") => Promise<string>;
}

export const startPortDiscovery = (options: PortDiscoveryOptions) => {
  const {
    send,
    reservedPorts = new Set<number>(),
    pollMs = 5_000,
    resendMs = 30_000,
    onResend,
    readTable = (family) =>
      readFile(
        family === "v4" ? "/proc/net/tcp" : "/proc/net/tcp6",
        "utf8",
      ).catch(() => ""),
  } = options;

  let last = "";
  let lastSentAt = 0;
  let stopped = false;

  const tick = async () => {
    try {
      const [v4, v6] = await Promise.all([readTable("v4"), readTable("v6")]);
      const ports = mergeListening(
        [...parseProcNetTcp(v4, "v4"), ...parseProcNetTcp(v6, "v6")],
        reservedPorts,
      );
      const key = JSON.stringify(ports);
      const now = Date.now();
      const resend = now - lastSentAt >= resendMs;
      if (key !== last || resend) {
        last = key;
        lastSentAt = now;
        if (!stopped) send({ kind: "ports.state", ports });
      }
      if (resend && !stopped) onResend?.();
    } catch (error) {
      log("warn", "port discovery failed", { error: String(error) });
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), pollMs);
  timer.unref?.();
  return {
    /** Force an immediate scan (tests, or after a share change). */
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
};
