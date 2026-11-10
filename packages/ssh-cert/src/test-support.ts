/**
 * Test helpers shared by the ssh-cert suites (only *.test.ts files import
 * this; it is not part of the package's exports).
 */
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ed25519SignerFromPrivateKeyPem, spkiToEd25519Raw } from "./keys";

/** A fresh ed25519 key pair in the three shapes the suites need. */
export const newKeyPair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicRaw: spkiToEd25519Raw(
      Buffer.from(publicKey.export({ format: "der", type: "spki" })),
    ),
    privateKey,
  };
};

/** A signer over a fresh ed25519 key. */
export const newSigner = () =>
  ed25519SignerFromPrivateKeyPem(newKeyPair().privatePem);

/**
 * Whether ssh-keygen is on PATH, for the cross-validation suites against the
 * reference implementation (skipped where it is absent).
 */
export const hasSshKeygen = (() => {
  try {
    execFileSync("ssh-keygen", ["-h"], { stdio: "ignore" });
    return true;
  } catch (err) {
    // ssh-keygen -h exits non-zero but existing; ENOENT means truly absent.
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
})();

/** Run `fn` in a fresh temp dir that is removed afterwards. */
export const withTempDir = <T>(prefix: string, fn: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
