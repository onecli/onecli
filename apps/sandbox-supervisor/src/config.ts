import {
  AGENT_EFFORTS,
  agentChannelPresenceSchema,
  agentConnectionSchema,
  agentPeerSchema,
  type AgentChannelPresenceWire,
  type AgentConnectionWire,
  type AgentEffort,
  type AgentPeerWire,
} from "@onecli/agent-protocol";
import { z } from "zod";
import { log } from "./log";

/**
 * Supervisor configuration, delivered entirely by environment: the runner
 * composes it from the spawn payload (step 3), and a hand-driven
 * `docker run -i` sets the same variables (step 2's dev loop).
 */
export interface SupervisorConfig {
  /** Absolute path of the agent's home (the durable volume). */
  homeDir: string;
  /**
   * The PROVIDER's model id; undefined = the harness's configured default.
   * The adapter translates it into its own vendor vocabulary (§3.5).
   */
  model: string | undefined;
  /** How hard to think, on our scale; undefined = the provider's default. */
  effort: AgentEffort | undefined;
  /** The agent's brief (§3.11), rendered at the top of the instruction doc. */
  instructions: string | undefined;
  /** The agent's display name — the identity the instruction doc states. */
  agentName: string | undefined;
  /**
   * The agent's channel presences at boot (the spawn payload's `channels`,
   * JSON in `AGENT_CHANNELS`) — the channels section's initial input; the
   * home-sync part refreshes it mid-run. Empty = no presences.
   */
  channels: AgentChannelPresenceWire[];
  /**
   * The peer agents this agent may message at boot (the spawn payload's
   * `peers`, JSON in `AGENT_PEERS`) - the `agents` capability's roster; the
   * home-sync part refreshes it mid-run. Empty = no peers, no tool.
   */
  peers: AgentPeerWire[];
  /**
   * The agent's attached app connections at boot (the spawn payload's
   * `connections`, JSON in `AGENT_CONNECTIONS`) — the connections section's
   * "connected apps" list, including each host-bound app's host; the
   * home-sync part refreshes it mid-run. Empty = none listed.
   */
  connections: AgentConnectionWire[];
  /** Adapter id; undefined = the composition root's default adapter. */
  harness: string | undefined;
  /**
   * The runner's control channel. Present = this sandbox was spawned by a
   * runner and should dial it; absent = stdio (the dev loop).
   */
  runnerWsUrl: string | undefined;
  /** Single-use bootstrap token for that channel (§5.1). */
  bootstrapToken: string | undefined;
  /** The runner relays files the agent sends back (send_file). False under
   * an older runner or the stdio dev driver: the tool is then not offered. */
  outboundAttachments: boolean;
  /**
   * Cadence of the turn-liveness heartbeat (`progress` frames) while a turn
   * is in flight. Test-only override, like the observer's `intervalMs` —
   * production always runs the default.
   */
  progressIntervalMs?: number;
}

/** Anything not on our scale is dropped, not forwarded — the env is only as
 *  trustworthy as whoever composed it, and a bad level would fail the turn. */
const parseEffort = (raw: string | undefined): AgentEffort | undefined =>
  AGENT_EFFORTS.find((effort) => effort === raw);

/**
 * The wire schema is the parser: malformed or partly-malformed JSON reads as
 * an EMPTY list rather than a crash at boot (an unrenderable section must
 * not stop the agent from starting; the next home sync re-delivers the real
 * list). Same posture as `parseEffort`. Shared by every env-delivered list
 * (channel presences, peer agents) so the boot rule cannot drift between
 * them - but say so: a silent [] would read as "none" to the agent while
 * the dashboard shows otherwise.
 */
const parseWireList = <T>(
  envName: string,
  raw: string | undefined,
  schema: z.ZodType<T>,
): T[] => {
  if (!raw) return [];
  try {
    const parsed = z.array(schema).safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    log("warn", `${envName} did not match the wire schema; booting with none`, {
      issues: parsed.error.issues.slice(0, 3).map((i) => i.message),
    });
    return [];
  } catch {
    log("warn", `${envName} is not JSON; booting with none`);
    return [];
  }
};

export const loadConfig = (): SupervisorConfig => ({
  homeDir: process.env.AGENT_HOME_DIR ?? "/workspace",
  model: process.env.AGENT_MODEL || undefined,
  effort: parseEffort(process.env.AGENT_EFFORT),
  instructions: process.env.AGENT_INSTRUCTIONS || undefined,
  agentName: process.env.AGENT_NAME || undefined,
  channels: parseWireList(
    "AGENT_CHANNELS",
    process.env.AGENT_CHANNELS,
    agentChannelPresenceSchema,
  ),
  peers: parseWireList("AGENT_PEERS", process.env.AGENT_PEERS, agentPeerSchema),
  connections: parseWireList(
    "AGENT_CONNECTIONS",
    process.env.AGENT_CONNECTIONS,
    agentConnectionSchema,
  ),
  harness: process.env.AGENT_HARNESS || undefined,
  runnerWsUrl: process.env.RUNNER_WS_URL || undefined,
  bootstrapToken: process.env.SANDBOX_WS_TOKEN || undefined,
  /** The runner can relay files the agent sends back (send_file). Set by a
   * runner that advertises outboundAttachments; absent under an older
   * runner or the stdio dev driver, where the tool must not be offered. */
  outboundAttachments: process.env.RUNNER_OUTBOUND_ATTACHMENTS === "1",
});
