import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The desktop is brought up from binaries the image may or may not have.
 * These tests stand in for them with shell scripts on a private PATH: each
 * fake does exactly what the real piece's readiness signal needs (Xvfb
 * creates the socket, dbus prints an address, xprop reports the WM check)
 * and records that it ran, so the ORDER and the ENV the pieces get are
 * what is proven, without an X server on the test host.
 */

const dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "desktop-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const fake = (bin: string, name: string, body: string) => {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

/**
 * A PATH holding every piece, each writing a line `<name> <DISPLAY> <bus>`
 * to `${log}` so the test can read back what ran and with what.
 */
const fakeDesktopBin = (log: string, options: { wmReady?: boolean } = {}) => {
  const bin = join(tmp(), "bin");
  mkdirSync(bin);
  const record = (name: string) =>
    `echo "${name} $DISPLAY ${"$"}{DBUS_SESSION_BUS_ADDRESS:-none}" >> "${log}"`;
  // Xvfb: the real one creates the socket once it accepts clients; the
  // fake creates it and then sleeps as the server would.
  fake(
    bin,
    "Xvfb",
    `${record("Xvfb")}\nmkdir -p /tmp/.X11-unix\ntouch "/tmp/.X11-unix/X\${1#:}"\nexec sleep 30`,
  );
  fake(
    bin,
    "dbus-daemon",
    `${record("dbus-daemon")}\necho "unix:path=/tmp/fake-bus,guid=abc"\nexec sleep 30`,
  );
  fake(bin, "xfwm4", `${record("xfwm4")}\nexec sleep 30`);
  fake(
    bin,
    "xprop",
    options.wmReady === false
      ? "exit 1"
      : 'echo "_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x400003"',
  );
  fake(bin, "xsetroot", record("xsetroot"));
  return bin;
};

/**
 * A PATH with the fakes first and the host's tools behind them: the fakes
 * are shell scripts that need `sh`, `mkdir`, `touch`, `sleep`. Reading the
 * host PATH is the point here, not a build input the task graph should
 * know about.
 */
// eslint-disable-next-line turbo/no-undeclared-env-vars
const withFakes = (bin: string) => `${bin}:${process.env.PATH ?? ""}`;

describe("desktopAvailable", () => {
  it("is true only when every piece is on PATH", async () => {
    const { desktopAvailable } = await import("./desktop");
    const bin = fakeDesktopBin(join(tmp(), "log"));
    expect(desktopAvailable({ PATH: bin })).toBe(true);
    rmSync(join(bin, "xfwm4"));
    expect(desktopAvailable({ PATH: bin })).toBe(false);
    expect(desktopAvailable({})).toBe(false);
  });
});

describe("startDesktop", () => {
  it("brings the pieces up in order, each with the display and the bus of the ones before", async () => {
    const { startDesktop, DISPLAY } = await import("./desktop");
    const log = join(tmp(), "log");
    const bin = fakeDesktopBin(log);
    // The stale-lock case: a previous life left the lock and socket behind.
    writeFileSync("/tmp/.X1-lock", "999\n");

    const desktop = await startDesktop({ PATH: withFakes(bin) });
    try {
      expect(desktop.display).toBe(DISPLAY);
      expect(desktop.dbusAddress).toBe("unix:path=/tmp/fake-bus,guid=abc");
      const lines = readFileSync(log, "utf8").trim().split("\n");
      expect(lines).toEqual([
        "Xvfb :1 none",
        "dbus-daemon :1 none",
        "xfwm4 :1 unix:path=/tmp/fake-bus,guid=abc",
        "xsetroot :1 unix:path=/tmp/fake-bus,guid=abc",
      ]);
      expect(existsSync("/tmp/.X1-lock")).toBe(false);
    } finally {
      desktop.close();
    }
  });

  it("gives up, and takes down what it started, when the window manager never reports in", async () => {
    const { startDesktop } = await import("./desktop");
    const log = join(tmp(), "log");
    const bin = fakeDesktopBin(log, { wmReady: false });
    await expect(startDesktop({ PATH: withFakes(bin) })).rejects.toThrow(
      /window manager did not come up/,
    );
    // The fakes are `sleep 30` once started; after close() none survive.
    const alive = spawnSync("pgrep", ["-f", `${bin}/`], { encoding: "utf8" });
    expect(alive.stdout.trim()).toBe("");
  }, 15_000);
});

describe("publishDisplay", () => {
  it("writes a fresh regular file, replacing a planted symlink rather than writing through it", async () => {
    const desktop = await import("./desktop");
    const dir = tmp();
    const target = join(dir, "elsewhere");
    writeFileSync(target, "untouched\n");
    rmSync(desktop.DISPLAY_FILE, { force: true });
    symlinkSync(target, desktop.DISPLAY_FILE);
    try {
      desktop.publishDisplay(":1");
      expect(() => readlinkSync(desktop.DISPLAY_FILE)).toThrow();
      expect(readFileSync(desktop.DISPLAY_FILE, "utf8")).toBe(":1\n");
      expect(readFileSync(target, "utf8")).toBe("untouched\n");
    } finally {
      rmSync(desktop.DISPLAY_FILE, { force: true });
    }
  });
});

describe("alignChromePolicyProxy", () => {
  it("rewrites only the proxy server and keeps every other policy", async () => {
    const { alignChromePolicyProxy } = await import("./desktop");
    const file = join(tmp(), "onecli.json");
    const shipped = {
      BrowserSignin: 0,
      ProxySettings: {
        ProxyMode: "fixed_servers",
        ProxyServer: "127.0.0.1:3128",
        ProxyBypassList: "<local>",
      },
    };
    writeFileSync(file, JSON.stringify(shipped));

    alignChromePolicyProxy("http://127.0.0.1:3129", file);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      ...shipped,
      ProxySettings: {
        ...shipped.ProxySettings,
        ProxyServer: "127.0.0.1:3129",
      },
    });
  });

  it("leaves an already-aligned file untouched", async () => {
    const { alignChromePolicyProxy } = await import("./desktop");
    const file = join(tmp(), "onecli.json");
    const text = '{"ProxySettings":{"ProxyServer":"127.0.0.1:3128"}}';
    writeFileSync(file, text);
    alignChromePolicyProxy("http://127.0.0.1:3128", file);
    // Byte-identical: no reformat, no mtime churn for nothing.
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  it("does nothing where the image ships no policy", async () => {
    const { alignChromePolicyProxy } = await import("./desktop");
    const file = join(tmp(), "absent.json");
    expect(() =>
      alignChromePolicyProxy("http://127.0.0.1:3129", file),
    ).not.toThrow();
    expect(existsSync(file)).toBe(false);
  });
});
