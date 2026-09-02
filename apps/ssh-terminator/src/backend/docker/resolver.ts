import {
  CERT_EXT_SANDBOX_ID,
  CERT_EXT_WORKSPACE_ID,
  CertificateVerificationError,
  GrantVerificationError,
  assertValidUserCertificate,
  getExtensionValue,
  parseCertificateLine,
  verifyGrant,
  type SshCertificate,
  type SshSessionGrant,
} from "@onecli/ssh-cert";
import {
  ResolverRefusedError,
  ResolverUnreachableError,
  type Resolver,
} from "../types";
import { DockerEngineError, type DockerEngineApi } from "./engine-api";
import type { DockerExecTarget } from "./exec-backend";

/**
 * The docker substrate's resolver. Unlike the kube arm — where an
 * independent broker process holds the trust anchor — resolver and relay
 * share this process, so the resolver verifies BOTH signed artifacts itself
 * (the Resolver contract's own-trust-anchor law, mirroring the manager
 * broker's checks one-for-one) before asking the daemon anything, then
 * resolves the sandbox to a RUNNING container by label at attach time:
 * every wake REPLACES the container, so a stored reference would be stale
 * by construction — the daemon's label index is the substrate's own
 * current truth.
 */

/** The runner's container labels (docker-backend.ts) — the lookup key. */
const LABEL_MANAGED = "sh.onecli.managed=1";
const LABEL_SANDBOX = "sh.onecli.sandbox-id";

/** How long a resolved container id may be reused before re-resolving.
 * Short by design: the lookup is one cheap local socket call, and the
 * pre-attach dial-retry (invalidateTarget) heals anything staler. */
const TARGET_REUSE_MS = 60_000;

/** Grant ids land in a label filter; our control plane only ever signs
 * well-shaped ids, so a violation is refused outright — never sanitized
 * (the manager broker's exact posture). */
const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

const verifyArtifacts = (
  input: { certificate: string; grant: string },
  caPublicKey: Buffer,
): { grant: SshSessionGrant; cert: SshCertificate } => {
  // The grant first: it is the control plane's blessing — without it,
  // nothing else about the request matters.
  let grant: SshSessionGrant;
  try {
    grant = verifyGrant(input.grant, caPublicKey, new Date());
  } catch (error) {
    if (error instanceof GrantVerificationError) {
      throw new ResolverRefusedError(
        "grant_refused",
        `session grant refused: ${error.reason}`,
      );
    }
    throw error;
  }
  for (const [field, value] of [
    ["sessionId", grant.sessionId],
    ["agentId", grant.agentId],
    ["sandboxId", grant.sandboxId],
    ["workspaceId", grant.workspaceId],
  ] as const) {
    if (!ID_SHAPE.test(value)) {
      throw new ResolverRefusedError(
        "grant_refused",
        `session grant refused: ${field} is not a valid id`,
      );
    }
  }

  let cert: SshCertificate;
  try {
    cert = parseCertificateLine(input.certificate);
    // The GRANT (verified above, with its own expiry) is what bounds this
    // session's lifetime; the certificate's short TTL only ever gated
    // session-OPEN (the control plane re-verified its freshness there
    // before signing the grant). So verify the cert's CA signature,
    // user-cert type, principal and no-critical-options — binding the
    // dialing identity to the grant — but NOT its validity window: a
    // legitimate long session (VS Code Remote, repeated exec/scp, sftp)
    // re-resolves targets for hours past the cert's ~10-min TTL, and the
    // grant already caps how long that can continue.
    assertValidUserCertificate(cert, {
      caPublicKey,
      principal: grant.agentId,
      ignoreValidityWindow: true,
    });
  } catch (error) {
    if (error instanceof CertificateVerificationError) {
      throw new ResolverRefusedError(
        "cert_refused",
        `certificate refused: ${error.reason}`,
      );
    }
    // Parse failures on attacker-controlled input are plain Errors.
    throw new ResolverRefusedError(
      "cert_refused",
      "certificate refused: malformed",
    );
  }

  // Cross-check the two signed artifacts against each other: the cert's
  // identity extensions and sole principal must equal the grant's tuple.
  if (
    getExtensionValue(cert, CERT_EXT_SANDBOX_ID) !== grant.sandboxId ||
    getExtensionValue(cert, CERT_EXT_WORKSPACE_ID) !== grant.workspaceId ||
    cert.principals[0] !== grant.agentId
  ) {
    throw new ResolverRefusedError(
      "identity_mismatch",
      "certificate and grant identify different subjects",
    );
  }
  return { grant, cert };
};

export interface DockerResolverOptions {
  engine: DockerEngineApi;
  /** Raw 32-byte CA public key — this process's own trust anchor. */
  caPublicKey: Buffer;
  now?: () => number;
}

export const createDockerResolver = (
  options: DockerResolverOptions,
): Resolver<DockerExecTarget> => {
  const now = options.now ?? Date.now;
  return {
    async open(input) {
      const { grant } = verifyArtifacts(input, options.caPublicKey);

      let containers;
      try {
        containers = await options.engine.listContainers([
          LABEL_MANAGED,
          `${LABEL_SANDBOX}=${grant.sandboxId}`,
        ]);
      } catch (error) {
        // Transport-class: the wake poll rides a daemon blip out, bounded.
        throw new ResolverUnreachableError(
          `docker daemon unreachable: ${
            error instanceof DockerEngineError ? error.message : String(error)
          }`,
        );
      }

      // /containers/json lists RUNNING containers only (all=false): during
      // the wake's replace-window (stop → remove → create → start) the
      // sandbox legitimately has none — that is "waking", never a refusal;
      // session-open already triggered the wake and the poll is bounded.
      if (containers.length === 0) return { status: "waking" };
      const [match] = containers;
      if (containers.length > 1 || !match) {
        // Two running containers claiming one sandbox id — a daemon shared
        // by colliding installs or a replace gone wrong. Picking one would
        // be guessing about a security boundary; refuse deterministically.
        throw new ResolverRefusedError(
          "ambiguous_container",
          "more than one running container claims this sandbox",
        );
      }
      return {
        status: "ready",
        target: { containerId: match.Id },
        expiresAt: new Date(now() + TARGET_REUSE_MS),
      };
    },

    // No per-session substrate state exists on this arm (the kube broker
    // deletes a per-session ServiceAccount trio here).
    close: () => Promise.resolve(),
  };
};
