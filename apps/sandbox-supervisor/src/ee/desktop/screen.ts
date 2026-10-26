import { connect } from "node:net";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  DESKTOP_CONTROL_PORT,
  DESKTOP_VIEW_PORT,
} from "@onecli/agent-protocol";
import type { DesktopHost, DesktopLayer } from "../../desktop";

/**
 * The hosted desktop's screen layer: what turns the sandbox desktop into
 * one a person can watch and, when the agent asks, drive.
 *
 * - The wallpaper, painted onto the bare root before the window manager
 *   takes the screen (its compositor keeps the root it finds).
 * - The dock at the bottom of the screen, once the manager is up.
 * - A view-only screen server, up for the desktop's life once the manager
 *   has the screen, and an input-accepting one only while a person holds
 *   control.
 *
 * Every piece is optional and probed: an image without it simply has a
 * desktop without that piece (no server means a screen nobody can watch).
 */

/** The wallpaper painter the image ships, and its default picture. */
const WALLPAPER_PAINTER = "onecli-wallpaper";
const DEFAULT_WALLPAPER = "/etc/onecli/wallpaper.png";

/**
 * The dock. `--disable-wm-check` because the manager is already up by the
 * time it starts. The panel reads its configuration from `XDG_CONFIG_HOME`
 * and writes back there (its channel, and a copy of every launcher it
 * resolves), so it is pointed at the image's own read-only dock directory,
 * which already holds the launchers where the panel looks first: nothing
 * to resolve, nothing written into the agent's home. The rest of the
 * desktop keeps its own config home.
 */
const DOCK = "xfce4-panel";
const DOCK_CONFIG_HOME = "/etc/onecli/dock";

/**
 * The screen server, the X-display scraper binary itself (the distro's
 * wrapper script of the same family rejects the `-Accept*` switches below).
 */
const SCREEN_SERVER = "X0tigervnc";

/** Whether something accepts on the loopback port: the readiness probe. */
const portOpen = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

/**
 * One command line for both server instances. Loopback only and no protocol
 * security: the port is reachable only through the platform's port stream,
 * which the control plane gates per viewer. `AlwaysShared` so a second
 * watcher never kicks the first. Input is decided per INSTANCE and never
 * flipped live (the server reads the switches once): the view instance
 * refuses pointer, keys and clipboard outright, so even a tampered client
 * gains nothing on that port; the control instance accepts all three.
 * Resizing stays refused on both: the screen is the agent's. The polling
 * switches only bound the fallback poller (updates are damage-driven).
 */
const serverArgs = (display: string, port: number, input: boolean) => {
  const accept = input ? "1" : "0";
  return [
    "-display",
    display,
    "-rfbport",
    String(port),
    "-localhost",
    "-SecurityTypes",
    "None",
    "-AlwaysShared",
    `-AcceptPointerEvents=${accept}`,
    `-AcceptKeyEvents=${accept}`,
    `-AcceptCutText=${accept}`,
    `-SendCutText=${accept}`,
    "-AcceptSetDesktopSize=0",
    "-FrameRate",
    "60",
    "-PollingCycle",
    "10",
    "-MaxProcessorUsage",
    "50",
    "-Log",
    "*:stderr:10",
  ];
};

export interface ScreenLayer extends DesktopLayer {
  /** Whether the screen can be watched (the view server is up). Read once
   * the desktop has started. */
  readonly viewable: () => boolean;
  /** Let a person drive the screen. Idempotent; resolves once it listens.
   * Rejects where the screen cannot be watched. */
  startControl(): Promise<void>;
  /** Take the input server down. Idempotent. */
  stopControl(): void;
}

export const createScreenLayer = (): ScreenLayer => {
  let host: DesktopHost | undefined;
  let viewable = false;
  let control: ChildProcess | undefined;

  const stopControl = () => {
    host?.stop(control);
    control = undefined;
  };

  return {
    viewable: () => viewable,

    paintRoot: async (desktop) => {
      const wallpaper =
        desktop.env.ONECLI_WALLPAPER?.trim() || DEFAULT_WALLPAPER;
      return (
        desktop.onPath(WALLPAPER_PAINTER) &&
        existsSync(wallpaper) &&
        (await desktop.run(WALLPAPER_PAINTER, [wallpaper])) !== undefined
      );
    },

    ready: async (desktop) => {
      host = desktop;
      // The dock is not waited on: a slow or absent panel costs nothing.
      if (desktop.onPath(DOCK)) {
        desktop.start(DOCK, ["--disable-wm-check"], {
          ...desktop.env,
          XDG_CONFIG_HOME: DOCK_CONFIG_HOME,
        });
      }
      if (!desktop.onPath(SCREEN_SERVER)) return;
      const view = desktop.start(
        SCREEN_SERVER,
        serverArgs(desktop.display, DESKTOP_VIEW_PORT, false),
      );
      try {
        await desktop.waitFor(
          () => portOpen(DESKTOP_VIEW_PORT),
          "the screen viewer",
        );
        viewable = true;
      } catch (error) {
        desktop.stop(view);
        throw error;
      }
    },

    startControl: async () => {
      if (!host || !viewable)
        throw new Error("desktop: the screen cannot be viewed");
      if (control && control.exitCode === null) return;
      // Its own child, not one of the desktop's pieces: it comes and goes
      // within the desktop's life, and close() takes it down first.
      control = host.spawn(
        SCREEN_SERVER,
        serverArgs(host.display, DESKTOP_CONTROL_PORT, true),
      );
      try {
        await host.waitFor(
          () => portOpen(DESKTOP_CONTROL_PORT),
          "the screen controller",
        );
      } catch (error) {
        stopControl();
        throw error;
      }
    },

    stopControl,
    close: stopControl,
  };
};
