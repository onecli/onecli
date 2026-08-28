/**
 * Pre-auth hardening for the public SSH listener. The NLB is pure L4 — it
 * adds zero flood protection — so these caps ARE the defense: a global
 * concurrent ceiling, a per-IP concurrent ceiling, and a per-IP token bucket
 * on connection attempts. Refusals are hint-free by contract (the caller
 * just ends the socket); the pre-auth TIMEOUT lives with the server, which
 * owns the sockets.
 */

export interface ConnectionLimits {
  /**
   * Admit one connection from `ip`. Returns a release handle (call exactly
   * once, when the connection closes) or null when refused.
   */
  admit(ip: string): (() => void) | null;
}

export interface ConnectionLimitsOptions {
  maxSessions: number;
  maxSessionsPerIp: number;
  preauthPerIpPerMinute: number;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
}

interface IpState {
  live: number;
  tokens: number;
  refilledAt: number;
}

export const createConnectionLimits = (
  options: ConnectionLimitsOptions,
): ConnectionLimits => {
  const now = options.now ?? Date.now;
  const capacity = options.preauthPerIpPerMinute;
  const perMs = capacity / 60_000;
  const byIp = new Map<string, IpState>();
  let liveTotal = 0;

  const refill = (state: IpState, at: number): void => {
    state.tokens = Math.min(
      capacity,
      state.tokens + (at - state.refilledAt) * perMs,
    );
    state.refilledAt = at;
  };

  // Bound the map: an idle entry (no live connections, bucket refilled to
  // full) carries no state worth keeping — prune opportunistically so a
  // scanning botnet cannot grow the map without bound.
  const prune = (at: number): void => {
    for (const [ip, state] of byIp) {
      refill(state, at);
      if (state.live === 0 && state.tokens >= capacity) byIp.delete(ip);
    }
  };

  return {
    admit(ip) {
      const at = now();
      if (liveTotal >= options.maxSessions) return null;
      if (byIp.size > 4096) prune(at);
      let state = byIp.get(ip);
      if (!state) {
        state = { live: 0, tokens: capacity, refilledAt: at };
        byIp.set(ip, state);
      }
      refill(state, at);
      if (state.live >= options.maxSessionsPerIp) return null;
      if (state.tokens < 1) return null;
      state.tokens -= 1;
      state.live += 1;
      liveTotal += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        liveTotal -= 1;
        const current = byIp.get(ip);
        if (current) current.live -= 1;
      };
    },
  };
};
