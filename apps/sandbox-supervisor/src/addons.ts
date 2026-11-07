import type {
  SupervisorMessage,
  SupervisorWorkItem,
} from "@onecli/agent-protocol";
import type { CapabilityFragment } from "./home/renderer";
import type { PlatformToolDefinition } from "./platform-tools";

/**
 * A capability a deployment adds to the supervisor without the supervisor
 * knowing its shape: fragments it teaches, tools it mounts, work items it
 * handles inline, and a report it repeats on the re-send beat. None by
 * default; the entrypoint decides which one, if any, this sandbox has.
 */
export interface SupervisorAddon {
  /** Rendered into the agent's capability docs, after the machine ones. */
  readonly fragments: readonly CapabilityFragment[];
  /** Mounted beside the platform tools. */
  readonly tools: readonly PlatformToolDefinition[];
  /** Guest ports the addon itself listens on: never discovered as shares. */
  readonly reservedPorts: readonly number[];
  /** An item routed to the addon. Inline from the reader loop, never
   * awaited by it. */
  handle?(item: SupervisorWorkItem, host: SupervisorAddonHost): void;
  /** Sent once at ready, then again on every re-send beat. */
  report?(send: (message: SupervisorMessage) => void): void;
}

/** What an addon may do to the running supervisor. */
export interface SupervisorAddonHost {
  /**
   * Steer EVERY live turn with a platform message, through the same inbox
   * every follow-up uses (ordering and outcome reporting included). `id`
   * mints the steer id per turn, so each live conversation gets exactly
   * one copy and a repeat adds none. Returns how many turns were steered.
   */
  steerLiveTurns(id: (turnId: string) => string, message: string): number;
}
