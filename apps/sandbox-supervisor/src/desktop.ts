import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter } from "node:path";

import { log } from "./log";

/**
 * The sandbox desktop: a virtual screen with a window manager and a session
 * bus, so a browser (or anything with a window) runs the way it does on a
 * person's computer rather than headless.
 *
 * Probing, not assuming. The shared agent image carries a display server
 * (Xvfb) and Chromium but no window manager; an image built on top of it
 * may add one (xfwm4) and a browser launcher. This module brings up what
 * the image has: no window manager on PATH means no desktop, and the
 * supervisor comes up exactly as before, with the agent told nothing about
 * a display. A sandbox is never degraded by an image that lacks the
 * desktop; it just does not have one.
 *
 * Why the supervisor and not the image's entrypoint: the display outlives
 * any one harness session and has to come up before the harness is
 * launched (the harness and its children inherit `DISPLAY` from the
 * environment, the way the open proxy's URL is inherited), and the
 * supervisor is the one process that lives for the whole sandbox.
 *
 * Why Xvfb and not a real X server with a dummy driver: Xvfb is already in
 * the shared image, needs no device and no root, and the difference (a
 * server-side framebuffer vs. a driver's) is invisible to the clients.
 *
 * Best-effort, like the open proxy: a failure to start any piece is logged
 * and the sandbox continues without a desktop. The pieces are the
 * supervisor's own children (not daemonized), so they die with it, and the
 * signal path kills them explicitly as well.
 */

/** The display number: `:1`, since `:0` is what a real session would be. */
const DISPLAY_NUMBER = 1;
export const DISPLAY = `:${String(DISPLAY_NUMBER)}`;

/**
 * The screen. 1280x800 is a common laptop panel and the size a maximized
 * browser window reports; 24-bit so pages render in true colour; 96 DPI so
 * CSS pixels are device pixels, as on a non-HiDPI screen.
 */
export const SCREEN = "1280x800x24";
const DPI = "96";
/** The root window's colour when nothing paints it: a plain dark field. */
const ROOT_COLOR = "#1e2330";

/** How long each piece gets to come up before the desktop is given up on.
 * Exported mutable so tests can shorten it. */
export const READY_TIMEOUT_MS = { value: 10_000 };
const POLL_MS = 100;

/**
 * Where the display is published for sessions that do not inherit the
 * supervisor's environment (an SSH login shell). The image's profile.d
 * drop-in reads it. One line, the display, boot-owned: rewritten every
 * start, never read back by this process. Same shape as the open proxy's
 * URL file.
 */
export const DISPLAY_FILE = "/tmp/onecli-display";

/**
 * Chrome's managed policy, when the image ships one. It pins the browser's
 * proxy to the open proxy at its usual port; when the open proxy had to
 * bind elsewhere, the policy is rewritten so the browser follows. The file
 * is owned by root and group-writable for the image's user for exactly
 * this write.
 */
export const CHROME_POLICY_FILE =
  "/etc/opt/chrome/policies/managed/onecli.json";

export interface Desktop {
  /** `:<n>`, what `DISPLAY` carries. */
  readonly display: string;
  /** The session bus address, what `DBUS_SESSION_BUS_ADDRESS` carries. */
  readonly dbusAddress: string | undefined;
  /** Stop every piece. Idempotent. */
  close(): void;
}

/**
 * What a {@link DesktopLayer} gets to work with: the desktop's display and
 * environment, and the same process discipline the desktop's own pieces
 * follow (own process group, unref'd, output discarded).
 */
export interface DesktopHost {
  readonly display: string;
  /** `DISPLAY`, and the session bus once it is up. */
  readonly env: NodeJS.ProcessEnv;
  /** Whether `name` resolves on the desktop's PATH. */
  onPath(name: string): boolean;
  /** Start a long-lived piece that goes down with the desktop. */
  start(command: string, args: string[], env?: NodeJS.ProcessEnv): ChildProcess;
  /** Start a piece the caller owns, and stops with {@link stop}. */
  spawn(command: string, args: string[], env?: NodeJS.ProcessEnv): ChildProcess;
  /** Stop a piece (its whole process group). Idempotent. */
  stop(child: ChildProcess | undefined): void;
  /** Run a short command to completion: its stdout, or undefined on failure. */
  run(
    command: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
  ): Promise<string | undefined>;
  /** Poll `ready` until it holds; rejects once the piece timeout passes. */
  waitFor(ready: () => boolean | Promise<boolean>, what: string): Promise<void>;
}

/**
 * Extra pieces a deployment layers onto the desktop as it comes up. The
 * desktop never needs one; each hook is best-effort, and a hook that fails
 * leaves the desktop exactly as it would be without the layer.
 */
export interface DesktopLayer {
  /**
   * Paint the root window on the bare X server, before the window manager
   * takes the screen. Resolves true when it painted, and the plain colour
   * is then skipped.
   */
  paintRoot?(host: DesktopHost): Promise<boolean>;
  /** Once the window manager has the screen. */
  ready?(host: DesktopHost): Promise<void>;
  /** First thing when the desktop closes: stop what the layer owns. */
  close?(): void;
}

/** Whether `name` resolves on `path`. Synchronous: it runs once at boot. */
const onPath = (name: string, path: string | undefined): boolean =>
  (path ?? "")
    .split(delimiter)
    .some((dir) => dir !== "" && existsSync(`${dir}/${name}`));

/** The binaries a desktop needs; absence of any one means no desktop. */
const REQUIRED = ["Xvfb", "xfwm4", "xprop", "dbus-daemon"] as const;

/** What the image has, for the boot log and the decision. */
export const desktopAvailable = (env: NodeJS.ProcessEnv): boolean =>
  REQUIRED.every((name) => onPath(name, env.PATH));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `ready` (sync or async, one probe at a time) until it holds or the timeout passes. */
const waitFor = async (
  ready: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = READY_TIMEOUT_MS.value,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() >= deadline) {
      throw new Error(
        `desktop: ${what} did not come up in ${String(timeoutMs)} ms`,
      );
    }
    await sleep(POLL_MS);
  }
};

/**
 * Spawn a long-lived piece with its own process group, output discarded,
 * unref'd: the standing rule that no child may be what holds the
 * supervisor's event loop (a supervisor whose transport has ended must
 * exit, and the pieces die with it). A spawn failure (the binary vanished
 * between the PATH probe and here) is absorbed: the readiness wait that
 * follows reports it as the piece not coming up, which is the truth.
 */
const start = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdio: "ignore" | ["ignore", "pipe", "ignore"] = "ignore",
): ChildProcess => {
  const child = spawn(command, args, {
    env,
    stdio,
    // Its own group, so a signal aimed at the supervisor's group by the
    // harness side never takes the display down mid-turn, and the close
    // path can kill the whole group it started.
    detached: true,
  });
  child.on("error", () => {});
  child.unref();
  return child;
};

const stop = (child: ChildProcess | undefined): void => {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // already gone
  }
};

/**
 * Run a short command to completion and return its stdout, or undefined
 * when it fails. For the readiness probes.
 */
const capture = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => resolve(code === 0 ? out : undefined));
  });

/**
 * The X server's socket, which Xvfb creates once it is accepting clients.
 * Checked as a file so no client library is needed before the server is up.
 */
const xSocketPath = (displayNumber: number) =>
  `/tmp/.X11-unix/X${String(displayNumber)}`;

/**
 * `_NET_SUPPORTING_WM_CHECK` on the root window is the EWMH way a window
 * manager says "I am running": set by xfwm4 once it has taken the screen.
 * A browser started before that gets no decorations and the wrong window
 * size, so the desktop is not ready until it is there.
 */
const wmRunning = async (env: NodeJS.ProcessEnv): Promise<boolean> => {
  const out = await capture(
    "xprop",
    ["-root", "_NET_SUPPORTING_WM_CHECK"],
    env,
  );
  return out !== undefined && out.includes("window id");
};

/**
 * Start the desktop. Resolves once the window manager has the screen, so a
 * caller that then exports `DISPLAY` hands out a display that is ready.
 */
export const startDesktop = async (
  baseEnv: NodeJS.ProcessEnv,
  layer?: DesktopLayer,
): Promise<Desktop> => {
  const display = DISPLAY;
  const env: NodeJS.ProcessEnv = { ...baseEnv, DISPLAY: display };
  const pieces: ChildProcess[] = [];
  const close = () => {
    layer?.close?.();
    for (const piece of pieces.splice(0).reverse()) stop(piece);
  };
  const host: DesktopHost = {
    display,
    env,
    onPath: (name) => onPath(name, env.PATH),
    start: (command, args, pieceEnv = env) => {
      const child = start(command, args, pieceEnv);
      pieces.push(child);
      return child;
    },
    spawn: (command, args, pieceEnv = env) => start(command, args, pieceEnv),
    stop,
    run: (command, args, runEnv = env) => capture(command, args, runEnv),
    waitFor: (ready, what) => waitFor(ready, what),
  };

  try {
    // A stale lock from a previous life of this container (the X server is
    // never shut down cleanly on a sandbox stop) would make Xvfb refuse the
    // display number. The lock belongs to a server that no longer exists:
    // nothing else in this container starts an X server.
    rmSync(`/tmp/.X${String(DISPLAY_NUMBER)}-lock`, { force: true });
    rmSync(xSocketPath(DISPLAY_NUMBER), { force: true });

    const xvfb = start(
      "Xvfb",
      [
        display,
        "-screen",
        "0",
        SCREEN,
        "-dpi",
        DPI,
        // GLX and RENDER: what a browser asks the server for; without GLX
        // WebGL has no context at all, and without RENDER text is drawn
        // the slow way.
        "+extension",
        "GLX",
        "+render",
        // Keep the screen's state when the last client disconnects: a
        // browser restart must not reset the root window.
        "-noreset",
        // Loopback socket only; nothing outside the sandbox can reach the
        // display.
        "-nolisten",
        "tcp",
      ],
      env,
    );
    pieces.push(xvfb);
    await waitFor(
      () => existsSync(xSocketPath(DISPLAY_NUMBER)),
      "the X server",
    );

    // The background, instead of X's root weave: what a screenshot shows
    // behind the browser. A layer may paint it; otherwise a plain dark
    // colour. Either has to land BEFORE the window manager: xfwm4's
    // compositor draws the screen from the root it finds when it takes
    // over, and a later change never shows.
    const painted = await (
      layer?.paintRoot?.(host) ?? Promise.resolve(false)
    ).catch((error: unknown) => {
      log("warn", "desktop: the layer could not paint the root", {
        error: String(error),
      });
      return false;
    });
    if (!painted && onPath("xsetroot", env.PATH)) {
      await capture("xsetroot", ["-solid", ROOT_COLOR], env);
    }

    // A private session bus: GTK (the window manager, the browser's file
    // dialogs) looks one up and logs a wall of warnings without it, and a
    // browser blocks on a secret-service lookup at startup when the bus is
    // there but empty, which `--password-store=basic` sidesteps.
    // `--print-address` on stdout; `--fork` would daemonize it out of the
    // supervisor's reach, so it stays a child.
    let dbusAddress: string | undefined;
    const dbus = start(
      "dbus-daemon",
      ["--session", "--nofork", "--nopidfile", "--print-address"],
      env,
      ["ignore", "pipe", "ignore"],
    );
    pieces.push(dbus);
    dbus.stdout?.on("data", (chunk: Buffer) => {
      dbusAddress ??= chunk.toString().trim().split("\n")[0];
    });
    await waitFor(() => dbusAddress !== undefined, "the session bus");
    // The address is read; the pipe must not keep the loop alive either.
    dbus.stdout?.destroy();
    env.DBUS_SESSION_BUS_ADDRESS = dbusAddress;

    // The window manager's settings come from xfconf (the image ships the
    // system defaults under /etc/xdg; the settings daemon is activated over
    // the bus above), so nothing is passed here beyond the compositor.
    // `--replace` takes the screen from a manager a previous life of this
    // container left behind, the way the lock removal above does for X.
    pieces.push(start("xfwm4", ["--replace", "--compositor=on"], env));
    await waitFor(() => wmRunning(env), "the window manager");

    // What a layer adds once the manager has the screen. Its own failure
    // is never the desktop's: the screen, bus and manager stay up.
    try {
      await layer?.ready?.(host);
    } catch (error) {
      log("warn", "desktop: a layer piece did not start", {
        error: String(error),
      });
    }

    return { display, dbusAddress, close };
  } catch (error) {
    close();
    throw error;
  }
};

export const publishDisplay = (display: string): void => {
  try {
    // Unlink first, then write a fresh regular file: /tmp is writable by
    // everything in the container, and writing THROUGH a planted symlink
    // would land the value wherever it points. `rmSync` removes a symlink
    // itself rather than following it.
    rmSync(DISPLAY_FILE, { force: true });
    writeFileSync(DISPLAY_FILE, `${display}\n`, { mode: 0o644, flag: "wx" });
  } catch (error) {
    // Best-effort: the harness still has the env; only the SSH door loses
    // the shortcut.
    log("warn", "desktop: could not publish the display file", {
      path: DISPLAY_FILE,
      error: String(error),
    });
  }
};

/**
 * Point the image's Chrome policy at the open proxy actually bound. The
 * policy ships with the proxy's usual port; a sandbox where that port was
 * taken (the open proxy walked to the next free one) would otherwise have
 * a browser whose policy names a proxy that is not there, and the policy
 * wins over the launcher's `--proxy-server`. No policy file = nothing to
 * do: an image without the desktop layer has none.
 */
export const alignChromePolicyProxy = (
  openProxyUrl: string,
  file = CHROME_POLICY_FILE,
): void => {
  if (!existsSync(file)) return;
  const hostPort = openProxyUrl.replace(/^http:\/\//, "");
  try {
    const policy = JSON.parse(readFileSync(file, "utf8")) as {
      ProxySettings?: { ProxyServer?: string };
    };
    if (policy.ProxySettings?.ProxyServer === hostPort) return;
    policy.ProxySettings = { ...policy.ProxySettings, ProxyServer: hostPort };
    writeFileSync(file, `${JSON.stringify(policy, null, 2)}\n`);
    log("info", "desktop: chrome policy proxy aligned to the open proxy", {
      proxy: hostPort,
    });
  } catch (error) {
    log("warn", "desktop: could not align the chrome policy proxy", {
      path: file,
      error: String(error),
    });
  }
};
