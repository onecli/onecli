import { createHash } from "node:crypto";

/**
 * A stable, non-secret fingerprint of THIS installation, derived from the
 * runner's registration token.
 *
 * The stale-label orphan sweep (runner.ts) enumerates every platform-labeled
 * object on the Docker daemon — deliberately, so it catches objects a DEAD
 * runner id left behind (a control-plane database reset mints a fresh id).
 * But "dead runner id" and "a DIFFERENT installation sharing this daemon" are
 * indistinguishable from the runner-id label alone, and the existence check
 * can only speak for the caller's own control plane — so without an
 * installation identity the sweep would reap a co-located install's LIVE
 * containers and durable home volumes (two self-host stacks on one host, or
 * the e2e suite on a machine with a live dev stack).
 *
 * The token is the right basis: it is the installation's registration anchor
 * (`config.ts` requires it), so it is STABLE across a database reset — the
 * canonical orphan case, which must still be reaped — and DIFFERENT per
 * install (install.sh generates a fresh one), so two installs never match.
 * It is hashed, never labeled raw: a docker label is world-readable to anyone
 * with daemon access, and the token is an `rnr_` secret.
 */
export const installationFingerprint = (token: string): string =>
  createHash("sha256").update(token).digest("hex").slice(0, 32);
