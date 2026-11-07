import { desktopControlSteerId, type WorkItem } from "@onecli/agent-protocol";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SupervisorAddonHost } from "../../addons";
import { browserHoldPath } from "../../browser-driver/paths";
import type { CapabilityFragment } from "../../home/renderer";
import { log } from "../../log";
import type { PlatformToolDefinition } from "../../platform-tools";

/**
 * The takeover capability: a person can watch the agent's screen and, for
 * a blocked step, take the mouse.
 *
 * - The CONTROL arm: the control plane's `desktop.control` flips the
 *   input-accepting screen server on and off, tells every live turn to
 *   stop or continue (a platform steer, like the ceiling warning), and
 *   sets the browser driver's hold marker so `onecli-browser` refuses to
 *   touch or read the page while the person has it. The steer is words the
 *   model may be slow to act on; the marker is what makes the refusal
 *   hold at the one place every browser verb passes through.
 * - The `request_human_takeover` tool and its fragment: how the agent asks
 *   for exactly this. Executed by the control plane (fencing, the card,
 *   audit); it returns at once, because a tool call cannot outlive the
 *   channel's ceilings and a person may take minutes. The hand-back reaches
 *   the agent as a steer (turn still live) or a new turn.
 */

type ControlItem = Extract<WorkItem, { kind: "desktop.control" }>;

/** The words a live turn gets when control changes hands. "[system]" like
 * the ceiling warning, so the model reads them as the platform's, not a
 * person's. Both say what to do NOW and nothing about why. */
export const DESKTOP_TAKEN_STEER_MESSAGE =
  "[system] A person has taken control of your desktop. Stop acting on the screen now: no clicks, no typing, no screenshots. Wait; you will be told when they are done.";
export const DESKTOP_RELEASED_STEER_MESSAGE =
  "[system] The person is done with your desktop and has handed it back. Look at the screen as it is now and continue.";

/** The input server the control arm flips. */
export interface ScreenControl {
  startControl(): Promise<void>;
  stopControl(): void;
}

export interface DesktopControl {
  /**
   * Handle a `desktop.control` work item. Inline from the reader loop,
   * never awaited by it: the server flip is a spawn/kill, the steer joins
   * the inbox. Every live turn is told, not "the" one: two conversations
   * can be in flight at once, and both may be acting on the same screen.
   */
  handle(item: ControlItem, host: SupervisorAddonHost): void;
}

/**
 * The hold marker, as the control arm sets it. The marker's whole content
 * is its existence; the file is a plain path so the driver (a different
 * process, started by the agent) needs no channel to the supervisor.
 */
export interface BrowserHold {
  set(): void;
  clear(): void;
}

export const browserHoldAt = (homeDir: string): BrowserHold => {
  const path = browserHoldPath(homeDir);
  return {
    set: () => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, "");
    },
    clear: () => rmSync(path, { force: true }),
  };
};

export const createDesktopControl = (
  screen: ScreenControl,
  hold: BrowserHold,
): DesktopControl => {
  let controlled = false;

  const handle = (item: ControlItem, host: SupervisorAddonHost) => {
    if (item.controlled === controlled) return; // idempotent re-send
    controlled = item.controlled;
    if (controlled) {
      // The marker first (it is what refuses the next browser verb), then
      // the server, then the words: by the time the model reads "stop",
      // the person's input already lands on the screen.
      try {
        hold.set();
      } catch (error) {
        log("warn", "desktop: browser hold not set", { error: String(error) });
      }
      void screen.startControl().catch((error: unknown) => {
        log("warn", "desktop: control server did not start", {
          error: String(error),
        });
      });
      const steered = host.steerLiveTurns(
        (turnId) => desktopControlSteerId(turnId, true),
        DESKTOP_TAKEN_STEER_MESSAGE,
      );
      log("info", "desktop: control taken", {
        controller: item.controllerName ?? null,
        steered,
      });
      return;
    }
    screen.stopControl();
    try {
      hold.clear();
    } catch (error) {
      log("warn", "desktop: browser hold not cleared", {
        error: String(error),
      });
    }
    const steered = host.steerLiveTurns(
      (turnId) => desktopControlSteerId(turnId, false),
      DESKTOP_RELEASED_STEER_MESSAGE,
    );
    log("info", "desktop: control released", { steered });
  };

  return { handle };
};

export const desktopFragment: CapabilityFragment = {
  id: "desktop",
  title: "Handing a step to a person (takeover)",
  body: `A person can watch your screen live from the dashboard and, when you
ask, take the mouse and keyboard for one step, then hand it back to you.

Ask for that, with request_human_takeover, when a step is theirs to do and
not yours: signing in to an account, a verification code or 2FA prompt, a
captcha or "verify you are human" check that one real click did not
clear, a payment or card entry, or any consent only they can give. Say in
\`reason\` what you need them to do, in one line, and leave the page exactly
where they need it (the form open, the prompt visible).

The call returns at once. Then END YOUR REPLY: tell them what you need and
stop. Do not poll, retry, or keep working on that page; the platform brings
you back when they are done, with the screen as they left it, and you
continue from there (same browser, same session). Ask once per step: a
second call does not speed anything up.

While a person holds control you will be told to stop acting on the
screen, and every onecli-browser verb answers that a person is using it.
Do exactly that until you are told they are done, even if the screen
changes under you: that is them working.`,
};

export const desktopTools: PlatformToolDefinition[] = [
  {
    name: "request_human_takeover",
    description:
      "Ask a person to take over your screen for one step you must not do yourself: a sign-in, a 2FA code, a captcha or bot check, a payment, a consent. Returns at once with the dashboard link the person gets; then end your reply and stop acting on that page. The platform resumes you when they hand the screen back.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          maxLength: 300,
          description:
            "One line for the person: what they need to do on the screen (e.g. 'Sign in to the supplier portal; the login form is open').",
        },
      },
      required: ["reason"],
    },
  },
];
