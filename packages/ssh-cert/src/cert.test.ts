import { execFileSync } from "node:child_process";
import { sign as cryptoSign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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
  formatEd25519PublicKeyLine,
  parseEd25519PublicKeyLine,
  type Ed25519Signer,
} from "./keys";
import {
  hasSshKeygen,
  newKeyPair,
  newSigner,
  withTempDir,
} from "./test-support";
import { WireWriter } from "./wire";

const caSigner = newSigner();
const user = newKeyPair();

const mint = async (overrides?: {
  principal?: string;
  validAfter?: Date;
  validBefore?: Date;
  signer?: Ed25519Signer;
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
    overrides?.signer ?? caSigner,
  );

/**
 * Re-sign `cert` with our CA after swapping in the given principals and
 * critical options: the signature is valid, so a refusal is the
 * verification law itself, never a bad signature.
 */
const resign = async (
  cert: SshCertificate,
  fields: { principals: string[]; criticalOptions: Buffer },
): Promise<Buffer> => {
  const principals = new WireWriter();
  for (const principal of fields.principals) principals.writeString(principal);
  const tbs = new WireWriter()
    .writeString(ED25519_CERT_TYPE)
    .writeString(Buffer.alloc(16))
    .writeString(cert.publicKey)
    .writeUint64(cert.serial)
    .writeUint32(cert.certType)
    .writeString(cert.keyId)
    .writeString(principals.toBuffer())
    .writeUint64(cert.validAfter)
    .writeUint64(cert.validBefore)
    .writeString(fields.criticalOptions)
    .writeString(Buffer.alloc(0))
    .writeString(Buffer.alloc(0))
    .writeString(cert.signatureKey)
    .toBuffer();
  const signature = await caSigner.sign(tbs);
  return new WireWriter()
    .writeBytes(tbs)
    .writeString(
      new WireWriter()
        .writeString("ssh-ed25519")
        .writeString(signature)
        .toBuffer(),
    )
    .toBuffer();
};

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
    const built = await mint({ signer: newSigner() });
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
    const foreign = await mint({
      validAfter: new Date(Date.now() - 7200_000),
      validBefore: new Date(Date.now() - 3600_000),
      signer: newSigner(),
    });
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
    const built = await mint();
    const criticalOptions = new WireWriter()
      .writeString("force-command")
      .writeString(new WireWriter().writeString("/bin/true").toBuffer())
      .toBuffer();
    const blob = await resign(parseCertificateBlob(built.blob), {
      principals: ["agent_1"],
      criticalOptions,
    });
    expect(() => verified(parseCertificateBlob(blob))).toThrow(
      expect.objectContaining({ reason: "unknown_critical_option" }),
    );
  });

  it("rejects an empty principal list (spec: empty = any)", async () => {
    const built = await mint();
    const blob = await resign(parseCertificateBlob(built.blob), {
      principals: [],
      criticalOptions: Buffer.alloc(0),
    });
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
describe.skipIf(!hasSshKeygen)("ssh-keygen cross-validation", () => {
  it("ssh-keygen -L reads a cert we minted", async () => {
    const built = await mint();
    withTempDir("onecli-ssh-cert-", (dir) => {
      const certPath = join(dir, "id_ed25519-cert.pub");
      writeFileSync(certPath, `${built.line}\n`);
      const out = execFileSync("ssh-keygen", ["-L", "-f", certPath], {
        encoding: "utf8",
      });
      expect(out).toContain("agent_1");
      expect(out).toContain("user cert");
      expect(out).toContain("permit-pty");
    });
  });

  it("we verify a cert ssh-keygen minted", () => {
    withTempDir("onecli-ssh-cert-", (dir) => {
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
      const certLine = readFileSync(`${userPath}-cert.pub`, "utf8");
      const caLine = readFileSync(`${caPath}.pub`, "utf8");
      const cert = parseCertificateLine(certLine);
      expect(() =>
        assertValidUserCertificate(cert, {
          caPublicKey: parseEd25519PublicKeyLine(caLine),
          principal: "agent_x",
        }),
      ).not.toThrow();
    });
  });
});
