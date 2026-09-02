import { randomBytes } from "node:crypto";

/**
 * Per-test identifiers, all derived from one nonce.
 *
 * These ids are not cosmetic — they are the suite's Redis isolation mechanism.
 * Per-test databases isolate rows, but Redis is a single shared instance that is
 * never flushed between tests, and the gateway keys its state by these ids:
 * the connect cache as `connect:{org}:{workspace}:{token}:{host}` with a 60-second
 * TTL, and rate-limit counters as `rate:{org}:{workspace}:{rule}:{token}:{window}`.
 *
 * Two tests reusing an org/workspace id therefore read each other's cached
 * resolution and share a rate-limit counter, and the resulting failure looks
 * like flake rather than like the collision it is. A fresh nonce per run also
 * means a re-run never inherits its own still-live cache entries.
 *
 * This is why the fixture builder exposes no parameter for any of these — a test
 * cannot pin one even by accident.
 */
export interface TestIds {
  readonly nonce: string;
  readonly org: string;
  readonly workspace: string;
  readonly agent: string;
  /** The plaintext value sent as `Proxy-Authorization: Basic base64("x:<token>")`. */
  readonly agentToken: string;
  /** A directory group, granted to the workspace when a rule binds it. */
  readonly group: string;
  /** A second agent, so a rule can bind a principal that is NOT the caller. */
  readonly otherAgent: string;
  readonly user: string;
  /** An `oc_` API key for the control-plane routes. */
  readonly apiKey: string;
  /** An `oc_org_` key: the released-SDK org-approvals watcher's credential. */
  readonly orgApiKey: string;
  /** Postgres identifier: starts with a letter, lowercase, no quoting needed. */
  readonly database: string;
}

export const newTestIds = (): TestIds => {
  const nonce = randomBytes(9).toString("hex");
  return {
    nonce,
    org: `e2e-${nonce}-org`,
    workspace: `e2e-${nonce}-ws`,
    agent: `e2e-${nonce}-agent`,
    agentToken: `aoc_e2e_${nonce}`,
    group: `e2e-${nonce}-group`,
    otherAgent: `e2e-${nonce}-agent2`,
    user: `e2e-${nonce}-user`,
    apiKey: `oc_e2e_${nonce}`,
    orgApiKey: `oc_org_e2e_${nonce}`,
    database: `e2e_${nonce}`,
  };
};
