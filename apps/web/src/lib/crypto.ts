import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

/**
 * CryptoService interface for encrypting and decrypting secrets.
 *
 * OSS uses AES-256-GCM with a local key from SECRET_ENCRYPTION_KEY env var.
 * Cloud swaps this module via turbopack alias to use AWS KMS envelope encryption.
 */
export interface CryptoService {
  encrypt: (plaintext: string) => string;
  decrypt: (encrypted: string) => string;
}

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Load and validate the encryption key from SECRET_ENCRYPTION_KEY env var.
 * Returns a 32-byte Buffer or null if not configured.
 */
const loadKey = (): Buffer | null => {
  const keyBase64 = process.env.SECRET_ENCRYPTION_KEY;
  if (!keyBase64) return null;

  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) {
    throw new Error(
      `SECRET_ENCRYPTION_KEY must be exactly 32 bytes (got ${key.length}). ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }

  return key;
};

let cachedKey: Buffer | null | undefined;

const getKey = (): Buffer => {
  if (cachedKey === undefined) {
    cachedKey = loadKey();
  }
  if (!cachedKey) {
    throw new Error(
      "SECRET_ENCRYPTION_KEY is not set. " +
        "Secret encryption requires this env var. " +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return cachedKey;
};

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a string in the format: {iv}:{authTag}:{ciphertext} (all base64-encoded).
 */
const encrypt = (plaintext: string): string => {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return [
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
};

/**
 * Decrypt a string produced by encrypt().
 * Expects format: {iv}:{authTag}:{ciphertext} (all base64-encoded).
 */
const decrypt = (encrypted: string): string => {
  const key = getKey();
  const [ivB64, authTagB64, ciphertextB64] = encrypted.split(":");

  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("invalid encrypted format: expected iv:authTag:ciphertext");
  }

  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");

  if (iv.length !== IV_LENGTH) {
    throw new Error(
      `invalid IV length: expected ${IV_LENGTH}, got ${iv.length}`,
    );
  }

  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error(
      `invalid auth tag length: expected ${AUTH_TAG_LENGTH}, got ${authTag.length}`,
    );
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
};

export const cryptoService: CryptoService = { encrypt, decrypt };
