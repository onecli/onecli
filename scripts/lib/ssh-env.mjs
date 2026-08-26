// Provision the SSH front door's coupled key material into a .env, so
// self-host SSH works out of the box (`pnpm dev` and `pnpm run setup` share
// this; install.sh mirrors it in POSIX sh). Unlike SECRET_SPECS — which mints
// each key independently — these values are DERIVED from one another, so they
// live here:
//
//   SSH_CA_PRIVATE_KEY       ed25519 PKCS#8 PEM (the api's onprem CA signer)
//   TERMINATOR_CA_PUBLIC_KEY the authorized_keys line derived from that key
//                            (the terminator's trust anchor — it must NEVER
//                            hold the private half)
//   TERMINATOR_HOST_KEY      ed25519 openssh-key-v1 (ssh2 rejects PKCS#8)
//   SSH_HOST                 the public hostname clients dial
//   SSH_PORT                 the advertised port (self-host default 10257)
//
// All-or-nothing by design: sshAvailable() lights on SSH_HOST + a CA signer
// alone, so a run that minted only some of these would advertise a door whose
// session-open then 401s. Idempotent per key (an existing value is never
// rewritten); the derived public line is re-derived if only it is missing.

import { createPublicKey, generateKeyPairSync } from "node:crypto";
import {
  formatEd25519PublicKeyLine,
  generateOpensshEd25519HostKey,
} from "./openssh-key.mjs";

/** The self-host default SSH port — an unprivileged high port (a default-on
 *  listener cannot bind :22); host-published as ONECLI_SSH_PORT in compose. */
export const DEFAULT_SSH_PORT = "10257";

/** node:crypto ed25519 → PKCS#8 PEM, exactly what ed25519SignerFromPrivateKeyPem parses. */
const generateCaPrivateKeyPem = () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  return typeof pem === "string" ? pem : pem.toString("utf8");
};

/** Derive the `ssh-ed25519 <base64>` authorized_keys line from the CA PEM.
 *  The raw 32-byte public point is the tail of the SPKI DER. */
const caPublicKeyLine = (pem) => {
  const spki = createPublicKey(pem).export({ format: "der", type: "spki" });
  return formatEd25519PublicKeyLine(spki.subarray(spki.length - 32));
};

/**
 * Ensure the SSH env is fully provisioned in `envFile` (no save — the caller
 * batches one atomic write). Reads the RESOLVED env (file ∪ shell) for the
 * present-checks, exactly like ensureSecrets.
 *
 * `sshPort`: write SSH_PORT only when given. `pnpm dev` passes it (the host
 * api reads SSH_PORT directly). The COMPOSE doors DON'T: the api service maps
 * `SSH_PORT: ${ONECLI_SSH_PORT:-10257}` so the published host port and the
 * advertised port are ONE knob — a SSH_PORT line in docker/.env would be dead
 * weight that could silently disagree.
 *
 * @returns the list of keys minted fresh (for the caller's summary line).
 */
export const ensureSshEnv = (envFile, resolved, { hostname, sshPort } = {}) => {
  // Cloud is a MODE, not a gap: the CA is KMS-injected and SSH_HOST/PORT come
  // from the deploy. Never mint local material there — it would shadow KMS.
  if ((resolved.EDITION ?? "").trim().toLowerCase() === "cloud") return [];

  const generated = [];
  const present = (key) => {
    const v = resolved[key];
    return v !== undefined && v.trim() !== "";
  };
  const put = (key, value, comment) => {
    envFile.upsert(key, value, { comment });
    generated.push(key);
  };

  // The CA key anchors the derivation — mint it (and its public line) first.
  let caPem = present("SSH_CA_PRIVATE_KEY")
    ? resolved.SSH_CA_PRIVATE_KEY
    : null;
  if (caPem === null) {
    caPem = generateCaPrivateKeyPem();
    put(
      "SSH_CA_PRIVATE_KEY",
      caPem,
      "SSH front door: the CA that signs user certificates (KEEP THIS — losing it invalidates every issued cert).",
    );
  }
  // Re-derive the public line whenever it is missing — even if the private
  // key already existed (an operator who set only the private half).
  if (!present("TERMINATOR_CA_PUBLIC_KEY")) {
    put(
      "TERMINATOR_CA_PUBLIC_KEY",
      caPublicKeyLine(caPem),
      "The terminator's CA trust anchor — derived from SSH_CA_PRIVATE_KEY (public half only).",
    );
  }
  if (!present("TERMINATOR_HOST_KEY")) {
    put(
      "TERMINATOR_HOST_KEY",
      generateOpensshEd25519HostKey(),
      "The terminator's SSH host key (openssh-key-v1).",
    );
  }
  if (!present("SSH_HOST")) {
    put(
      "SSH_HOST",
      hostname ?? "localhost",
      "Public SSH host clients dial — set to this deployment's externally reachable name.",
    );
  }
  if (sshPort !== undefined && !present("SSH_PORT")) {
    put(
      "SSH_PORT",
      sshPort,
      "Public SSH port the dashboard advertises (matches the terminator's published host port).",
    );
  }
  return generated;
};
