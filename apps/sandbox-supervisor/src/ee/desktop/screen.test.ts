import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startDesktop } from "../../desktop";
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
} from "../../testing/desktop-fakes";
import { createScreenLayer } from "./screen";

/**
 * The hosted screen layer on the real desktop start, with the image's
 * pieces faked on a private PATH: the wallpaper painter, the dock, and the
 * screen server (which records its port and input switch, then LISTENS,
 * since readiness is a connect probe).
 */
const withLayerFakes = (
  log: string,
  options: {
    server?: boolean | "stalls";
    wallpaper?: boolean | "fails";
    dock?: boolean;
  } = {},
) => {
  const bin = fakeDesktopBin(log);
  if (options.wallpaper) {
    fake(
      bin,
      "onecli-wallpaper",
      `${record(log, "onecli-wallpaper $1")}\n${options.wallpaper === "fails" ? "exit 1" : "exit 0"}`,
    );
  }
  if (options.dock) {
    fake(
      bin,
      "xfce4-panel",
      // Records its config home too: the panel reads AND writes there.
      `${record(log, "xfce4-panel $1 config-home=${XDG_CONFIG_HOME:-unset}")}\n${notePid(bin)}\nexec sleep 30`,
    );
  }
  if (options.server) {
    const listen =
      options.server === "stalls"
        ? "exec sleep 30"
        : `exec node -e 'require("node:net").createServer().listen(Number(process.argv[1]), "127.0.0.1")' "$port"`;
    fake(
      bin,
      "X0tigervnc",
      `port=""; input=""
while [ $# -gt 0 ]; do
  case "$1" in
    -rfbport) port="$2"; shift ;;
    -AcceptPointerEvents=*) input="\${1#*=}" ;;
  esac
  shift
done
echo "X0tigervnc $port input=$input" >> "${log}"
${notePid(bin)}
${listen}`,
    );
  }
  return bin;
};

/** Wait for a piece that is started but not waited on to record itself. */
const untilLogged = async (log: string, prefix: string) => {
  const deadline = Date.now() + 2_000;
  while (
    !logLines(log).some((l) => l.startsWith(prefix)) &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
};

describe("the wallpaper", () => {
  it("is painted before the window manager, and the plain colour never runs", async () => {
    const wallpaper = join(tmp(), "wall.png");
    writeFileSync(wallpaper, "not really a png");
    const log = join(tmp(), "log");
    const bin = withLayerFakes(log, { wallpaper: true });
    const desktop = await startDesktop(
      { PATH: withFakes(bin), ONECLI_WALLPAPER: wallpaper },
      createScreenLayer(),
    );
    try {
      expect(logLines(log)).toEqual([
        "Xvfb :1 none",
        `onecli-wallpaper ${wallpaper} :1 none`,
        "dbus-daemon :1 none",
        "xfwm4 :1 unix:path=/tmp/fake-bus,guid=abc",
      ]);
    } finally {
      desktop.close();
    }
  });

  it("falls back to the plain colour when the paint fails", async () => {
    const wallpaper = join(tmp(), "wall.png");
    writeFileSync(wallpaper, "not really a png");
    const log = join(tmp(), "log");
    const bin = withLayerFakes(log, { wallpaper: "fails" });
    const desktop = await startDesktop(
      { PATH: withFakes(bin), ONECLI_WALLPAPER: wallpaper },
      createScreenLayer(),
    );
    try {
      expect(logLines(log).slice(0, 3)).toEqual([
        "Xvfb :1 none",
        `onecli-wallpaper ${wallpaper} :1 none`,
        "xsetroot :1 none",
      ]);
    } finally {
      desktop.close();
    }
  });

  it("is not tried when the picture is missing", async () => {
    const log = join(tmp(), "log");
    const bin = withLayerFakes(log, { wallpaper: true });
    const desktop = await startDesktop(
      { PATH: withFakes(bin), ONECLI_WALLPAPER: join(tmp(), "absent.png") },
      createScreenLayer(),
    );
    try {
      expect(logLines(log).slice(0, 2)).toEqual([
        "Xvfb :1 none",
        "xsetroot :1 none",
      ]);
    } finally {
      desktop.close();
    }
  });
});

describe("the dock", () => {
  it("starts after the window manager with the image's dock dir as its config home, and goes down with the rest", async () => {
    const log = join(tmp(), "log");
    const bin = withLayerFakes(log, { dock: true });
    // The desktop's own config home must not leak into the dock (the panel
    // would write its channel and launcher copies there), and the dock's
    // must not leak into the rest of the desktop.
    const desktop = await startDesktop(
      { PATH: withFakes(bin), XDG_CONFIG_HOME: "/home/agent/.config" },
      createScreenLayer(),
    );
    try {
      await untilLogged(log, "xfce4-panel");
      expect(logLines(log).slice(-2)).toEqual([
        "xfwm4 :1 unix:path=/tmp/fake-bus,guid=abc",
        "xfce4-panel --disable-wm-check config-home=/etc/onecli/dock :1 unix:path=/tmp/fake-bus,guid=abc",
      ]);
      // Xvfb, the bus, the manager, the dock: all four go with close().
      expect(startedPids(bin)).toHaveLength(4);
    } finally {
      desktop.close();
    }
    expect(await survivors(startedPids(bin))).toEqual([]);
  });
});

describe("the screen servers", () => {
  it("are absent without the server binary: nothing viewable, no control", async () => {
    const layer = createScreenLayer();
    const bin = withLayerFakes(join(tmp(), "log"));
    const desktop = await startDesktop({ PATH: withFakes(bin) }, layer);
    try {
      expect(layer.viewable()).toBe(false);
      await expect(layer.startControl()).rejects.toThrow(/cannot be viewed/);
    } finally {
      desktop.close();
    }
  });

  it("start the view-only one after the window manager, and the input one only on control", async () => {
    const layer = createScreenLayer();
    const log = join(tmp(), "log");
    const bin = withLayerFakes(log, { server: true });
    const desktop = await startDesktop({ PATH: withFakes(bin) }, layer);
    try {
      expect(layer.viewable()).toBe(true);
      // View-only, after the window manager has the screen (a watcher must
      // never see a bare root), input refused on that instance.
      expect(logLines(log).slice(-2)).toEqual([
        "xfwm4 :1 unix:path=/tmp/fake-bus,guid=abc",
        "X0tigervnc 5900 input=0",
      ]);
      expect(startedPids(bin)).toHaveLength(4);

      await layer.startControl();
      expect(logLines(log).at(-1)).toBe("X0tigervnc 5901 input=1");
      const controlPid = startedPids(bin).at(-1)!;
      expect(startedPids(bin)).toHaveLength(5);
      // Idempotent: a second start while it runs spawns nothing.
      await layer.startControl();
      expect(startedPids(bin)).toHaveLength(5);

      layer.stopControl();
      expect(await survivors([controlPid])).toEqual([]);
      layer.stopControl(); // idempotent
      // The view instance is untouched by a control stop.
      expect(await survivors(startedPids(bin).slice(0, 4))).toHaveLength(4);

      // close() takes a live control server down with everything else.
      await layer.startControl();
    } finally {
      desktop.close();
    }
    expect(await survivors(startedPids(bin))).toEqual([]);
  }, 20_000);

  it("leave a usable, unviewable desktop when the view server never listens", async () => {
    const layer = createScreenLayer();
    const bin = withLayerFakes(join(tmp(), "log"), { server: "stalls" });
    const desktop = await startDesktop({ PATH: withFakes(bin) }, layer);
    try {
      expect(layer.viewable()).toBe(false);
      // The stalled server was taken down; the desktop's three pieces live.
      const pids = startedPids(bin);
      expect(pids).toHaveLength(4);
      expect(await survivors([pids[3]!])).toEqual([]);
      expect(await survivors(pids.slice(0, 3))).toHaveLength(3);
    } finally {
      desktop.close();
    }
  }, 20_000);
});
