import { randomBytes } from "node:crypto";

/**
 * Per-test identifiers, all derived from one nonce (the gateway-e2e law).
 *
 * Two extra rules are load-bearing HERE:
 *
 *  - `sandbox` ids carry the `he2e-` prefix ON PURPOSE: the runner names
 *    containers `onecli-sandbox-<sandboxId>` and volumes
 *    `onecli-home-<sandboxId>`, so pinning the id makes every Docker object a
 *    stale run leaves behind sweepable BY NAME PREFIX (globalSetup) without
 *    ever touching a real local stack, whose sandbox ids are cuids. This is
 *    why deep-lane hosted agents are always fixture-seeded, never API-created.
 *  - `network` gets a per-test name: the docker backend fails closed on an
 *    existing same-named network with the wrong isolation flag, so per-test
 *    names mean no state can leak from a previous run's posture.
 */
export interface TestIds {
  readonly nonce: string;
  readonly org: string;
  readonly workspace: string;
  readonly user: string;
  readonly agent: string;
  readonly agentToken: string;
  readonly sandbox: string;
  /** A second tenant (multi-tenant hardening legs). */
  readonly secondOrg: string;
  readonly secondWorkspace: string;
  readonly secondAgent: string;
  readonly secondAgentToken: string;
  readonly secondSandbox: string;
  readonly secondUser: string;
  /** An `oc_` API key for the /v1 client and the gateway approvals control. */
  readonly apiKey: string;
  readonly secondApiKey: string;
  /** The per-test runner registration token (`rnr_`). */
  readonly runnerToken: string;
  /** The per-test sandbox bridge network. */
  readonly network: string;
  /** Postgres identifier: starts with a letter, lowercase, no quoting. */
  readonly database: string;
}

export const newTestIds = (): TestIds => {
  const nonce = randomBytes(9).toString("hex");
  return {
    nonce,
    org: `he2e-${nonce}-org`,
    workspace: `he2e-${nonce}-ws`,
    user: `he2e-${nonce}-user`,
    agent: `he2e-${nonce}-agent`,
    agentToken: `aoc_he2e_${nonce}`,
    sandbox: `he2e-${nonce}-sbx`,
    secondOrg: `he2e-${nonce}-org2`,
    secondWorkspace: `he2e-${nonce}-ws2`,
    secondAgent: `he2e-${nonce}-agent2`,
    secondAgentToken: `aoc_he2e_${nonce}b`,
    secondSandbox: `he2e-${nonce}-sbx2`,
    secondUser: `he2e-${nonce}-user2`,
    apiKey: `oc_he2e_${nonce}`,
    secondApiKey: `oc_he2e_${nonce}b`,
    runnerToken: `rnr_he2e_${nonce}`,
    network: `oce2e-${nonce}`,
    database: `he2e_${nonce}`,
  };
};
