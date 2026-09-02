import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CERT_EXT_SANDBOX_ID,
  CERT_EXT_USER_ID,
  CERT_EXT_WORKSPACE_ID,
  ED25519_CERT_TYPE,
  assertValidUserCertificate,
  buildUserCertificate,
  getExtensionValue,
  parseCertificateBlob,
  parseCertificateLine,
  verifyPossession,
  type SshCertificate,
  type VerifyUserCertificateOptions,
} from "./cert";
import {
  ed25519SignerFromPrivateKeyPem,
  formatEd25519PublicKeyLine,
  parseEd25519PublicKeyLine,
  spkiToEd25519Raw,
} from "./keys";
import { WireWriter } from "./wire";

const newKeyPair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicRaw: spkiToEd25519Raw(
      Buffer.from(publicKey.export({ format: "der", type: "spki" })),
    ),
    privateKey,
  };
};

const ca = newKeyPair();
const caSigner = ed25519SignerFromPrivateKeyPem(ca.privatePem);
const user = newKeyPair();

const mint = async (overrides?: {
  principal?: string;
  validAfter?: Date;
  validBefore?: Date;
}) =>
  buildUserCertificate(
    {
      userPublicKey: user.publicRaw,
      keyId: JSON.stringify({
        u: "user_1",
        e: "u@example.com",
        a: "agent_1",
        w: "ws_1",
      }),
      principal: overrides?.principal ?? "agent_1",
      validAfter: overrides?.validAfter ?? new Date(Date.now() - 60_000),
      validBefore: overrides?.validBefore ?? new Date(Date.now() + 600_000),
      sandboxId: "sbx_1",
      workspaceId: "ws_1",
      userId: "user_1",
    },
    caSigner,
  );

describe("buildUserCertificate / parseCertificateBlob", () => {
  it("round-trips every field", async () => {
    const built = await mint();
    const cert = parseCertificateBlob(built.blob);
    expect(cert.publicKey.equals(user.publicRaw)).toBe(true);
    expect(cert.certType).toBe(1);
    expect(cert.principals).toEqual(["agent_1"]);
    expect(cert.serial).toBe(built.serial);
    expect(cert.criticalOptions).toEqual([]);
    expect(getExtensionValue(cert, CERT_EXT_SANDBOX_ID)).toBe("sbx_1");
    expect(getExtensionValue(cert, CERT_EXT_WORKSPACE_ID)).toBe("ws_1");
    expect(getExtensionValue(cert, CERT_EXT_USER_ID)).toBe("user_1");
    // Lexical extension order is a protocol requirement, not a style choice.
    expect(cert.extensions.map((ext) => ext.name)).toEqual(
      [...cert.extensions.map((ext) => ext.name)].sort(),
    );
    expect(() =>
      assertValidUserCertificate(cert, { caPublicKey: caSigner.publicKey }),
    ).not.toThrow();
  });

  it("parses the single-line form and rejects foreign line types", async () => {
    const built = await mint();
    const cert = parseCertificateLine(`${built.line} user@laptop`);
    expect(cert.principals).toEqual(["agent_1"]);
    expect(() =>
      parseCertificateLine(`ssh-ed25519 ${built.blob.toString("base64")}`),
    ).toThrow(/expected an/);
  });
});

describe("assertValidUserCertificate", () => {
  const verified = (
    cert: SshCertificate,
    opts?: Omit<VerifyUserCertificateOptions, "caPublicKey">,
  ) =>
    assertValidUserCertificate(cert, {
      caPublicKey: caSigner.publicKey,
      ...opts,
    });

  it("rejects a foreign CA", async () => {
    const foreignCa = ed25519SignerFromPrivateKeyPem(newKeyPair().privatePem);
    const built = await buildUserCertificate(
      {
        userPublicKey: user.publicRaw,
        keyId: "{}",
        principal: "agent_1",
        validAfter: new Date(Date.now() - 60_000),
        validBefore: new Date(Date.now() + 600_000),
        sandboxId: "sbx_1",
        workspaceId: "ws_1",
        userId: "user_1",
      },
      foreignCa,
    );
    expect(() => verified(parseCertificateBlob(built.blob))).toThrow(
      expect.objectContaining({ reason: "wrong_ca" }),
    );
  });

  it("rejects a tampered blob (flipped tbs byte)", async () => {
    const built = await mint();
    // Flip a byte inside the keyId region — the CA signature must fail.
    const tampered = Buffer.from(built.blob);
    const cert = parseCertificateBlob(built.blob);
    const idx = built.blob.indexOf(Buffer.from(cert.keyId, "utf8"));
    expect(idx).toBeGreaterThan(0);
    tampered[idx] = (tampered[idx] ?? 0) ^ 0xff;
    expect(() => verified(parseCertificateBlob(tampered))).toThrow(
      expect.objectContaining({ reason: "bad_signature" }),
    );
  });

  it("rejects expiry and not-yet-valid windows", async () => {
    const expired = await mint({
      validAfter: new Date(Date.now() - 120_000),
      validBefore: new Date(Date.now() - 60_000),
    });
    expect(() => verified(parseCertificateBlob(expired.blob))).toThrow(
      expect.objectContaining({ reason: "expired" }),
    );
    const future = await mint({
      validAfter: new Date(Date.now() + 60_000),
      validBefore: new Date(Date.now() + 120_000),
    });
    expect(() => verified(parseCertificateBlob(future.blob))).toThrow(
      expect.objectContaining({ reason: "not_yet_valid" }),
    );
  });

  it("ignoreValidityWindow accepts an expired cert but keeps every other check", async () => {
    // The broker's re-verification path: the grant bounds the session, so an
    // expired cert (past its ~10-min TTL) must still verify for re-brokering
    // — while CA signature, principal and critical-option checks all stay.
    const expired = await mint({
      validAfter: new Date(Date.now() - 7200_000),
      validBefore: new Date(Date.now() - 3600_000),
    });
    const cert = parseCertificateBlob(expired.blob);
    expect(() => verified(cert, { ignoreValidityWindow: true })).not.toThrow();
    // Still bound: a wrong principal is refused even with the window skipped.
    expect(() =>
      verified(cert, { principal: "agent_2", ignoreValidityWindow: true }),
    ).toThrow(expect.objectContaining({ reason: "wrong_principal" }));
    // And a foreign CA is still refused with the window skipped.
    const foreignCa = ed25519SignerFromPrivateKeyPem(newKeyPair().privatePem);
    const foreign = await buildUserCertificate(
      {
        userPublicKey: user.publicRaw,
        keyId: "{}",
        principal: "agent_1",
        validAfter: new Date(Date.now() - 7200_000),
        validBefore: new Date(Date.now() - 3600_000),
        sandboxId: "sbx_1",
        workspaceId: "ws_1",
        userId: "user_1",
      },
      foreignCa,
    );
    expect(() =>
      verified(parseCertificateBlob(foreign.blob), {
        ignoreValidityWindow: true,
      }),
    ).toThrow(expect.objectContaining({ reason: "wrong_ca" }));
  });

  it("rejects a wrong principal", async () => {
    const built = await mint();
    expect(() =>
      verified(parseCertificateBlob(built.blob), { principal: "agent_2" }),
    ).toThrow(expect.objectContaining({ reason: "wrong_principal" }));
  });

  it("rejects any critical option — we never mint them", async () => {
    // Re-sign a cert that carries a critical option with our own CA: the
    // signature is valid, so the refusal is the critical-option law itself.
    const built = await mint();
    const cert = parseCertificateBlob(built.blob);
    const criticalPacked = new WireWriter()
      .writeString("force-command")
      .writeString(new WireWriter().writeString("/bin/true").toBuffer())
      .toBuffer();
    const tbs = new WireWriter()
      .writeString(ED25519_CERT_TYPE)
      .writeString(Buffer.alloc(16))
      .writeString(cert.publicKey)
      .writeUint64(cert.serial)
      .writeUint32(cert.certType)
      .writeString(cert.keyId)
      .writeString(new WireWriter().writeString("agent_1").toBuffer())
      .writeUint64(cert.validAfter)
      .writeUint64(cert.validBefore)
      .writeString(criticalPacked)
      .writeString(Buffer.alloc(0))
      .writeString(Buffer.alloc(0))
      .writeString(cert.signatureKey)
      .toBuffer();
    const signature = await caSigner.sign(tbs);
    const blob = new WireWriter()
      .writeBytes(tbs)
      .writeString(
        new WireWriter()
          .writeString("ssh-ed25519")
          .writeString(signature)
          .toBuffer(),
      )
      .toBuffer();
    expect(() => verified(parseCertificateBlob(blob))).toThrow(
      expect.objectContaining({ reason: "unknown_critical_option" }),
    );
  });

  it("rejects an empty principal list (spec: empty = any)", async () => {
    const built = await mint();
    const cert = parseCertificateBlob(built.blob);
    const tbs = new WireWriter()
      .writeString(ED25519_CERT_TYPE)
      .writeString(Buffer.alloc(16))
      .writeString(cert.publicKey)
      .writeUint64(cert.serial)
      .writeUint32(cert.certType)
      .writeString(cert.keyId)
      .writeString(Buffer.alloc(0))
      .writeUint64(cert.validAfter)
      .writeUint64(cert.validBefore)
      .writeString(Buffer.alloc(0))
      .writeString(Buffer.alloc(0))
      .writeString(Buffer.alloc(0))
      .writeString(cert.signatureKey)
      .toBuffer();
    const signature = await caSigner.sign(tbs);
    const blob = new WireWriter()
      .writeBytes(tbs)
      .writeString(
        new WireWriter()
          .writeString("ssh-ed25519")
          .writeString(signature)
          .toBuffer(),
      )
      .toBuffer();
    expect(() => verified(parseCertificateBlob(blob))).toThrow(
      expect.objectContaining({ reason: "no_principals" }),
    );
  });
});

describe("verifyPossession", () => {
  it("accepts raw and SSH-wrapped signatures over the auth blob", async () => {
    const built = await mint();
    const cert = parseCertificateBlob(built.blob);
    const authBlob = Buffer.from("session-id|userauth-request|payload");
    const raw = cryptoSign(null, authBlob, user.privateKey);
    expect(verifyPossession(cert, authBlob, raw)).toBe(true);
    const wrapped = new WireWriter()
      .writeString("ssh-ed25519")
      .writeString(raw)
      .toBuffer();
    expect(verifyPossession(cert, authBlob, wrapped)).toBe(true);
    expect(verifyPossession(cert, Buffer.from("other"), raw)).toBe(false);
  });
});

describe("public key line helpers", () => {
  it("round-trips authorized_keys lines and refuses non-ed25519", () => {
    const line = formatEd25519PublicKeyLine(user.publicRaw, "u@laptop");
    expect(parseEd25519PublicKeyLine(line).equals(user.publicRaw)).toBe(true);
    expect(() => parseEd25519PublicKeyLine("ssh-rsa AAAAB3Nza")).toThrow(
      /expected an/,
    );
  });
});

// Cross-validation against the reference implementation: ssh-keygen must
// both display our minted cert and mint one our parser + verifier accept.
// Skipped where ssh-keygen is unavailable (the pure-JS vectors above still
// pin the format).
const hasSshKeygen = (() => {
  try {
    execFileSync("ssh-keygen", ["-h"], { stdio: "ignore" });
    return true;
  } catch (err) {
    // ssh-keygen -h exits non-zero but existing; ENOENT means truly absent.
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
})();

describe.skipIf(!hasSshKeygen)("ssh-keygen cross-validation", () => {
  it("ssh-keygen -L reads a cert we minted", async () => {
    const built = await mint();
    const dir = mkdtempSync(join(tmpdir(), "onecli-ssh-cert-"));
    try {
      const certPath = join(dir, "id_ed25519-cert.pub");
      writeFileSync(certPath, `${built.line}\n`);
      const out = execFileSync("ssh-keygen", ["-L", "-f", certPath], {
        encoding: "utf8",
      });
      expect(out).toContain("agent_1");
      expect(out).toContain("user cert");
      expect(out).toContain("permit-pty");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("we verify a cert ssh-keygen minted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "onecli-ssh-cert-"));
    try {
      const caPath = join(dir, "ca");
      const userPath = join(dir, "id_ed25519");
      execFileSync("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        caPath,
      ]);
      execFileSync("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        userPath,
      ]);
      execFileSync("ssh-keygen", [
        "-q",
        "-s",
        caPath,
        "-I",
        "cross-check",
        "-n",
        "agent_x",
        "-V",
        "-1m:+10m",
        `${userPath}.pub`,
      ]);
      const { readFileSync } = await import("node:fs");
      const certLine = readFileSync(`${userPath}-cert.pub`, "utf8");
      const caLine = readFileSync(`${caPath}.pub`, "utf8");
      const cert = parseCertificateLine(certLine);
      expect(() =>
        assertValidUserCertificate(cert, {
          caPublicKey: parseEd25519PublicKeyLine(caLine),
          principal: "agent_x",
        }),
      ).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
