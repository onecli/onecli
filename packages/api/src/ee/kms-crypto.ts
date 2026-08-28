import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import {
  KMSClient,
  GenerateDataKeyCommand,
  DecryptCommand,
} from "@aws-sdk/client-kms";

import type { CryptoService } from "../lib/crypto-types";
import { KMS_KEY_ARN } from "../lib/env";

export type { CryptoService };

/**
 * Cloud CryptoService using AWS KMS envelope encryption.
 *
 * Each secret gets a unique data key via KMS GenerateDataKey. The plaintext
 * data key encrypts the secret locally (AES-256-GCM), then is zeroed from
 * memory. Only the KMS-encrypted data key is stored alongside the ciphertext.
 *
 * Encryption context binds each operation to its purpose, preventing encrypted
 * data keys from being used in a different context. It also appears in
 * CloudTrail logs for auditing.
 *
 * Storage format: {encryptedDataKey}:{iv}:{authTag}:{ciphertext} (all base64)
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

const ENCRYPTION_CONTEXT = { purpose: "onecli-secret-encryption" };

const getKeyArn = (): string => {
  if (!KMS_KEY_ARN) {
    throw new Error("KMS_KEY_ARN env var is required in cloud edition");
  }
  return KMS_KEY_ARN;
};

// Lazy singleton — constructed on first use, never at import time. The crypto
// server-root edition-defaults module imports this file (the injector picks the
// implementation at runtime), so merely loading it must not build an AWS client.
let kmsClient: KMSClient | null = null;
const kms = (): KMSClient => (kmsClient ??= new KMSClient({}));

const encrypt = async (plaintext: string): Promise<string> => {
  const keyArn = getKeyArn();

  const { Plaintext: dataKey, CiphertextBlob: encryptedDataKey } =
    await kms().send(
      new GenerateDataKeyCommand({
        KeyId: keyArn,
        KeySpec: "AES_256",
        EncryptionContext: ENCRYPTION_CONTEXT,
      }),
    );

  if (!dataKey || !encryptedDataKey) {
    throw new Error("KMS GenerateDataKey returned empty response");
  }

  try {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, dataKey, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });

    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return [
      Buffer.from(encryptedDataKey).toString("base64"),
      iv.toString("base64"),
      authTag.toString("base64"),
      encrypted.toString("base64"),
    ].join(":");
  } finally {
    dataKey.fill(0);
  }
};

const decrypt = async (stored: string): Promise<string> => {
  const parts = stored.split(":");

  if (parts.length === 3) {
    throw new Error(
      "Secret uses legacy encryption format (3 parts). " +
        "Re-create the secret to encrypt with KMS.",
    );
  }

  if (parts.length !== 4) {
    throw new Error(
      "Invalid encrypted format: expected encryptedDataKey:iv:authTag:ciphertext",
    );
  }

  const [edkB64, ivB64, authTagB64, ciphertextB64] = parts;
  const encryptedDataKey = Buffer.from(edkB64!, "base64");
  const iv = Buffer.from(ivB64!, "base64");
  const authTag = Buffer.from(authTagB64!, "base64");
  const ciphertext = Buffer.from(ciphertextB64!, "base64");

  const { Plaintext: dataKey } = await kms().send(
    new DecryptCommand({
      CiphertextBlob: encryptedDataKey,
      EncryptionContext: ENCRYPTION_CONTEXT,
    }),
  );

  if (!dataKey) {
    throw new Error("KMS Decrypt returned empty plaintext");
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, dataKey, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString("utf8");
  } finally {
    dataKey.fill(0);
  }
};

export const cryptoService: CryptoService = { encrypt, decrypt };
