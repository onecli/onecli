import {
  GetPublicKeyCommand,
  KMSClient,
  SignCommand,
} from "@aws-sdk/client-kms";
import { spkiToEd25519Raw } from "@onecli/ssh-cert";

import { SSH_CA_KMS_KEY_ARN } from "../../lib/env";
import type { SshCaSigner } from "../../providers/types";

/**
 * Cloud SSH CA: an asymmetric KMS key (ECC_NIST_EDWARDS25519) whose private
 * half is non-extractable — every certificate/grant mint is a kms:Sign call,
 * IAM-scoped to the api-server task and visible in CloudTrail. Pure Ed25519:
 * MessageType RAW (the whole to-be-signed blob goes to KMS, never a digest —
 * FIPS 186-5 EdDSA signs the message itself) and the returned signature is
 * the raw 64 bytes, no DER/mpint conversion anywhere.
 *
 * Lazy client + null-when-unconfigured: `ensureEditionDefaults()` imports
 * this module on every cloud boot, so import must stay side-effect free, and
 * an unset SSH_CA_KMS_KEY_ARN means the SSH surface is dark, not broken.
 */
let kmsClient: KMSClient | null = null;
const kms = (): KMSClient => (kmsClient ??= new KMSClient({}));

const buildSigner = (keyArn: string): SshCaSigner => {
  // The CA public key is immutable for the key's lifetime — fetch once.
  let publicKey: Promise<Buffer> | null = null;

  return {
    getPublicKey: () =>
      (publicKey ??= (async () => {
        const out = await kms().send(
          new GetPublicKeyCommand({ KeyId: keyArn }),
        );
        if (!out.PublicKey) throw new Error("KMS GetPublicKey returned no key");
        return spkiToEd25519Raw(Buffer.from(out.PublicKey));
      })().catch((err: unknown) => {
        // A failed fetch must not poison every later mint with a rejected
        // memo — clear it so the next call retries.
        publicKey = null;
        throw err;
      })),
    sign: async (data) => {
      const out = await kms().send(
        new SignCommand({
          KeyId: keyArn,
          Message: data,
          MessageType: "RAW",
          SigningAlgorithm: "ED25519_SHA_512",
        }),
      );
      if (!out.Signature) throw new Error("KMS Sign returned no signature");
      return Buffer.from(out.Signature);
    },
  };
};

/** Null when the CA key is not configured — the SSH surface stays dark. */
export const kmsSshCa: SshCaSigner | null = SSH_CA_KMS_KEY_ARN
  ? buildSigner(SSH_CA_KMS_KEY_ARN)
  : null;
