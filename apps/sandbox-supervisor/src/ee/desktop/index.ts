import {
  DESKTOP_CONTROL_PORT,
  DESKTOP_VIEW_PORT,
  type SupervisorWorkItem,
} from "@onecli/agent-protocol";
import type { SupervisorAddon } from "../../addons";
import type { DesktopLayer } from "../../desktop";
import { log } from "../../log";
import {
  browserHoldAt,
  createDesktopControl,
  desktopFragment,
  desktopTools,
} from "./control";
import { createScreenLayer, type ScreenLayer } from "./screen";

/**
 * The hosted desktop, as the supervisor's entrypoint wires it: a screen
 * layer for the desktop as it comes up, and an addon for the supervisor
 * once it is known whether the screen came up viewable.
 *
 * Present only on the hosted platform, where the runner carries port
 * streams (the only way a watcher reaches the screen).
 */
export interface HostedDesktop {
  /** Layered onto the sandbox desktop as it starts. */
  readonly layer: DesktopLayer;
  /**
   * The supervisor addon for this sandbox: `desktopStarted` says whether
   * the desktop itself came up (false: none in the image, or it failed).
   *
   * - A viewable screen: the takeover tool and fragment, the control arm,
   *   and a `viewable: true` report.
   * - A desktop nobody can watch, or none at all: only the report, saying
   *   `viewable: false`, so the dashboard says so instead of waiting.
   */
  addon(desktopStarted: boolean): SupervisorAddon;
}

/**
 * `homeDir` is where the browser driver's hold marker goes (the agent's
 * durable home); `screen` is the test seam, the real layer by default.
 */
export const createHostedDesktop = (
  homeDir: string,
  screen: ScreenLayer = createScreenLayer(),
): HostedDesktop => ({
  layer: screen,
  addon: (desktopStarted) => {
    const viewable = desktopStarted && screen.viewable();
    // The hold marker lives on the durable home and this process starts
    // with no lease in hand: a marker a previous life left (a restart
    // mid-takeover) would otherwise refuse every browser verb until the
    // next take-and-release, since a "released" push matches the arm's
    // initial state and is skipped as a re-send. A live lease is pushed
    // again on the first poll and sets it back.
    const hold = browserHoldAt(homeDir);
    try {
      hold.clear();
    } catch (error) {
      log("warn", "desktop: stale browser hold not cleared", {
        error: String(error),
      });
    }
    const control = viewable ? createDesktopControl(screen, hold) : undefined;
    return {
      fragments: viewable ? [desktopFragment] : [],
      tools: viewable ? desktopTools : [],
      // The screen servers are platform listeners: never a share.
      reservedPorts: [DESKTOP_VIEW_PORT, DESKTOP_CONTROL_PORT],
      handle: (item: SupervisorWorkItem, host) => {
        if (item.kind === "desktop.control") control?.handle(item, host);
      },
      report: (send) => send({ kind: "desktop.state", viewable }),
    };
  },
});
