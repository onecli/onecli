import {
  existsSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  fake,
  fakeDesktopBin,
  logLines,
  notePid,
  record,
  startedPids,
  survivors,
  tmp,
  withFakes,
} from "./testing/desktop-fakes";

/**
 * The desktop is brought up from binaries the image may or may not have.
 * These tests stand in for them with shell scripts on a private PATH
 * (testing/desktop-fakes.ts), so the ORDER and the ENV the pieces get are
 * what is proven, without an X server on the test host.
 */

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
      // The root colour lands before the window manager: its compositor
      // keeps the root it finds, so a later paint never shows.
      expect(logLines(log)).toEqual([
        "Xvfb :1 none",
        "xsetroot :1 none",
        "dbus-daemon :1 none",
        "xfwm4 :1 unix:path=/tmp/fake-bus,guid=abc",
      ]);
      expect(existsSync("/tmp/.X1-lock")).toBe(false);
    } finally {
      desktop.close();
    }
  });

  it("gives up, and takes down what it started, when the window manager never reports in", async () => {
    const { startDesktop, READY_TIMEOUT_MS } = await import("./desktop");
    const original = READY_TIMEOUT_MS.value;
    READY_TIMEOUT_MS.value = 2_000;
    onTestFinished(() => {
      READY_TIMEOUT_MS.value = original;
    });
    const log = join(tmp(), "log");
    const bin = fakeDesktopBin(log, { wmReady: false });
    await expect(startDesktop({ PATH: withFakes(bin) })).rejects.toThrow(
      /window manager did not come up/,
    );
    // Every long-lived piece that started is gone after close(): the three
    // that ran (Xvfb, the bus, the window manager), each by its own pid.
    const pids = startedPids(bin);
    expect(pids).toHaveLength(3);
    expect(await survivors(pids)).toEqual([]);
  }, 15_000);
});

describe("a desktop layer", () => {
  it("paints the root in place of the plain colour, then adds its pieces once the manager is up, all going down with close()", async () => {
    const { startDesktop } = await import("./desktop");
    const log = join(tmp(), "log");
    const bin = fakeDesktopBin(log);
    fake(bin, "painter", record(log, "painter"));
    fake(
      bin,
      "extra",
      `${record(log, "extra")}\n${notePid(bin)}\nexec sleep 30`,
    );
    const closed: string[] = [];
    const desktop = await startDesktop(
      { PATH: withFakes(bin) },
      {
        paintRoot: async (host) =>
          (await host.run("painter", [])) !== undefined,
        ready: async (host) => {
          host.start("extra", []);
          await host.waitFor(
            () => startedPids(bin).length === 4,
            "the extra piece",
          );
        },
        close: () => closed.push("layer"),
      },
    );
    try {
      expect(logLines(log)).toEqual([
        "Xvfb :1 none",
        "painter :1 none",
        "dbus-daemon :1 none",
        "xfwm4 :1 unix:path=/tmp/fake-bus,guid=abc",
        "extra :1 unix:path=/tmp/fake-bus,guid=abc",
      ]);
    } finally {
      desktop.close();
    }
    expect(closed).toEqual(["layer"]);
    expect(await survivors(startedPids(bin))).toEqual([]);
  }, 20_000);

  it("falls back to the plain colour when the paint fails or throws", async () => {
    const { startDesktop } = await import("./desktop");
    for (const paintRoot of [
      async () => false,
      async () => {
        throw new Error("no painter");
      },
    ]) {
      const log = join(tmp(), "log");
      const desktop = await startDesktop(
        { PATH: withFakes(fakeDesktopBin(log)) },
        { paintRoot },
      );
      desktop.close();
      expect(logLines(log).slice(0, 2)).toEqual([
        "Xvfb :1 none",
        "xsetroot :1 none",
      ]);
    }
  }, 20_000);

  it("never costs the desktop: a layer whose pieces fail leaves the screen, bus and manager up", async () => {
    const { startDesktop } = await import("./desktop");
    const bin = fakeDesktopBin(join(tmp(), "log"));
    const desktop = await startDesktop(
      { PATH: withFakes(bin) },
      {
        ready: async () => {
          throw new Error("a piece did not start");
        },
      },
    );
    try {
      expect(desktop.display).toBe(":1");
      expect(await survivors(startedPids(bin))).toHaveLength(3);
    } finally {
      desktop.close();
    }
  }, 20_000);
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
