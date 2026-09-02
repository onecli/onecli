import { AGENT_EFFORTS, type AgentEffort } from "@onecli/agent-protocol";

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
  /** Adapter id; undefined = the composition root's default adapter. */
  harness: string | undefined;
  /**
   * The runner's control channel. Present = this sandbox was spawned by a
   * runner and should dial it; absent = stdio (the dev loop).
   */
  runnerWsUrl: string | undefined;
  /** Single-use bootstrap token for that channel (§5.1). */
  bootstrapToken: string | undefined;
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

export const loadConfig = (): SupervisorConfig => ({
  homeDir: process.env.AGENT_HOME_DIR ?? "/workspace",
  model: process.env.AGENT_MODEL || undefined,
  effort: parseEffort(process.env.AGENT_EFFORT),
  instructions: process.env.AGENT_INSTRUCTIONS || undefined,
  agentName: process.env.AGENT_NAME || undefined,
  harness: process.env.AGENT_HARNESS || undefined,
  runnerWsUrl: process.env.RUNNER_WS_URL || undefined,
  bootstrapToken: process.env.SANDBOX_WS_TOKEN || undefined,
});
