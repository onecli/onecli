import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

/**
 * Test-only stand-ins for the desktop's binaries: shell scripts on a
 * private PATH. Each fake does exactly what the real piece's readiness
 * signal needs (Xvfb creates the socket, dbus prints an address, xprop
 * reports the WM check) and records that it ran, so the ORDER and the ENV
 * the pieces get are what is proven, without an X server on the test host.
 */

const dirs: string[] = [];
export const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "desktop-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** Write an executable shell script `name` into `bin`. */
export const fake = (bin: string, name: string, body: string) => {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

const pidFile = (bin: string) => join(bin, "pids");

/** The pids the long-lived fakes noted, in start order. */
export const startedPids = (bin: string): number[] =>
  existsSync(pidFile(bin))
    ? readFileSync(pidFile(bin), "utf8").trim().split("\n").map(Number)
    : [];

/** Signal 0 probes without signalling: only ESRCH means the pid is gone. */
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

/** The pids still alive once a SIGTERM has had time to land and be reaped. */
export const survivors = async (pids: number[]): Promise<number[]> => {
  const deadline = Date.now() + 2_000;
  let alive = pids.filter(isAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    alive = alive.filter(isAlive);
  }
  return alive;
};

/** The line a fake writes to the log: `<name> <DISPLAY> <bus>`. */
export const record = (log: string, name: string) =>
  `echo "${name} $DISPLAY ${"$"}{DBUS_SESSION_BUS_ADDRESS:-none}" >> "${log}"`;

/** Note the fake's pid: `exec` keeps it, so it is the test's handle on
 * whether close() really took the piece down. */
export const notePid = (bin: string) => `echo $$ >> "${pidFile(bin)}"`;

/**
 * A PATH holding the desktop's four required pieces and `xsetroot`, each
 * writing a line `<name> <DISPLAY> <bus>` to `${log}` so the test can read
 * back what ran and with what.
 *
 * The fake xprop answers like the real one: the WM check is on the root
 * window only once the window manager has taken the screen, which here is
 * once the fake xfwm4 has recorded its line and dropped its marker. Without
 * that, `startDesktop` can resolve while xfwm4 is still starting, and the
 * log is read before xfwm4 wrote to it.
 */
export const fakeDesktopBin = (
  log: string,
  options: { wmReady?: boolean } = {},
) => {
  const bin = join(tmp(), "bin");
  mkdirSync(bin);
  const wmMarker = join(bin, "wm-running");
  // Xvfb: the real one creates the socket once it accepts clients; the
  // fake creates it and then sleeps as the server would.
  fake(
    bin,
    "Xvfb",
    `${record(log, "Xvfb")}\n${notePid(bin)}\nmkdir -p /tmp/.X11-unix\ntouch "/tmp/.X11-unix/X\${1#:}"\nexec sleep 30`,
  );
  fake(
    bin,
    "dbus-daemon",
    `${record(log, "dbus-daemon")}\n${notePid(bin)}\necho "unix:path=/tmp/fake-bus,guid=abc"\nexec sleep 30`,
  );
  fake(
    bin,
    "xfwm4",
    `${record(log, "xfwm4")}\n${notePid(bin)}\ntouch "${wmMarker}"\nexec sleep 30`,
  );
  fake(
    bin,
    "xprop",
    options.wmReady === false
      ? "exit 1"
      : `[ -e "${wmMarker}" ] || exit 1\necho "_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x400003"`,
  );
  fake(bin, "xsetroot", record(log, "xsetroot"));
  return bin;
};

/**
 * A PATH with the fakes first and the host's tools behind them: the fakes
 * are shell scripts that need `sh`, `mkdir`, `touch`, `sleep`. Reading the
 * host PATH is the point here, not a build input the task graph should
 * know about.
 */
// eslint-disable-next-line turbo/no-undeclared-env-vars
export const withFakes = (bin: string) => `${bin}:${process.env.PATH ?? ""}`;

/** The log's lines, in the order the fakes wrote them. */
export const logLines = (log: string) =>
  readFileSync(log, "utf8").trim().split("\n");
