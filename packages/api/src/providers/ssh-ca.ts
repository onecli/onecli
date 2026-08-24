import { ed25519SignerFromPrivateKeyPem } from "@onecli/ssh-cert";

import { SSH_CA_PRIVATE_KEY } from "../lib/env";
import { createEditionSlot } from "./edition-state";
import type { SshCaSigner } from "./types";

/**
 * The SSH certificate authority (plans/sandbox-platform.md step 5): signs
 * user certificates and session grants. Nullable by design — `null` means
 * the SSH front door is not configured and the whole surface stays dark
 * (the RUNNER_TOKEN posture). Cloud injects the KMS-backed signer via
 * `ensureEditionDefaults()` (the private key never leaves KMS); onprem signs
 * in-process with the SSH_CA_PRIVATE_KEY PEM when an operator sets one.
 */
const buildLocalSigner = (): SshCaSigner | null => {
  if (!SSH_CA_PRIVATE_KEY) return null;
  const signer = ed25519SignerFromPrivateKeyPem(SSH_CA_PRIVATE_KEY);
  return {
    getPublicKey: () => Promise.resolve(signer.publicKey),
    sign: signer.sign,
  };
};

// Memoized thunk: parsing the PEM once per process, not per read.
let localSigner: SshCaSigner | null | undefined;
const slot = createEditionSlot<SshCaSigner | null>(
  "sshCa",
  () => (localSigner ??= buildLocalSigner()),
);

export const initSshCa = (s: SshCaSigner | null) => slot.init(s);

/** Package-internal: the edition-defaults injector. Not exported from the barrel. */
export const setDefaultSshCa = (s: SshCaSigner | null) =>
  slot.setCloudDefault(s);

export const getSshCa = (): SshCaSigner | null => slot.get();
