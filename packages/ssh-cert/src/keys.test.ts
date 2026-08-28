import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ed25519Fingerprint,
  formatEd25519PublicKeyLine,
  parseEd25519PublicKeyLine,
  spkiToEd25519Raw,
} from "./keys";

const freshRawKey = (): Buffer => {
  const { publicKey } = generateKeyPairSync("ed25519");
  return spkiToEd25519Raw(
    Buffer.from(publicKey.export({ format: "der", type: "spki" })),
  );
};

describe("ed25519Fingerprint", () => {
  it("produces the OpenSSH SHA256 shape with no padding", () => {
    const fp = ed25519Fingerprint(freshRawKey());
    // 32 hash bytes base64-encode to 44 chars with one "=" pad; OpenSSH
    // strips the pad, leaving exactly 43.
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it("is a function of the key material alone", () => {
    const raw = freshRawKey();
    const bare = parseEd25519PublicKeyLine(formatEd25519PublicKeyLine(raw));
    const commented = parseEd25519PublicKeyLine(
      formatEd25519PublicKeyLine(raw, "someone@laptop"),
    );
    expect(ed25519Fingerprint(bare)).toBe(ed25519Fingerprint(commented));
    expect(ed25519Fingerprint(freshRawKey())).not.toBe(ed25519Fingerprint(raw));
  });

  it("refuses non-32-byte input", () => {
    expect(() => ed25519Fingerprint(Buffer.alloc(31))).toThrow(/32 bytes/);
  });
});

// Cross-validation against the reference implementation (the cert.test.ts
// convention): ssh-keygen -lf must print exactly our fingerprint for the
// same key. Skipped where ssh-keygen is unavailable.
const hasSshKeygen = (() => {
  try {
    execFileSync("ssh-keygen", ["-h"], { stdio: "ignore" });
    return true;
  } catch (err) {
    // ssh-keygen -h exits non-zero but existing; ENOENT means truly absent.
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
})();

describe.skipIf(!hasSshKeygen)(
  "ssh-keygen fingerprint cross-validation",
  () => {
    it("matches ssh-keygen -lf byte for byte", () => {
      const raw = freshRawKey();
      const dir = mkdtempSync(join(tmpdir(), "onecli-ssh-fp-"));
      try {
        const keyPath = join(dir, "id_ed25519.pub");
        writeFileSync(keyPath, `${formatEd25519PublicKeyLine(raw, "t@t")}\n`);
        const out = execFileSync("ssh-keygen", ["-lf", keyPath], {
          encoding: "utf8",
        });
        // Output shape: "256 SHA256:<b64> t@t (ED25519)".
        expect(out.split(/\s+/)[1]).toBe(ed25519Fingerprint(raw));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
