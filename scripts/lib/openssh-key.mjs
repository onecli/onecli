// Generate an ed25519 host key in OpenSSH's own private-key format
// (`-----BEGIN OPENSSH PRIVATE KEY-----`, aka openssh-key-v1).
//
// Why not just a PKCS#8 PEM (which node:crypto emits directly): the
// terminator parses its host key with ssh2 1.17.0, whose key parser accepts
// ONLY openssh-key-v1 or legacy PEM restricted to RSA/DSA/EC — a PKCS#8
// ed25519 PEM is rejected outright, so a host key minted the same way as the
// CA key would fail at handshake on every fresh self-host install. This is
// ~40 lines of the documented format (PROTOCOL.key), unencrypted, dependency-
// free — the same node:crypto the other generators use, no ssh-keygen needed.

import { generateKeyPairSync, randomBytes } from "node:crypto";

const AUTH_MAGIC = Buffer.from("openssh-key-v1\0", "binary");

/** SSH wire `string`: a uint32 big-endian length prefix + the bytes. */
const sshString = (bytes) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
};

const sshText = (text) => sshString(Buffer.from(text, "utf8"));

/**
 * The `ssh-ed25519 <base64>` authorized_keys line for a raw 32-byte public
 * key — the exact shape TERMINATOR_CA_PUBLIC_KEY is parsed from. Kept here
 * (not imported from @onecli/ssh-cert) because scripts run as plain node and
 * that package exports raw TypeScript.
 */
export const formatEd25519PublicKeyLine = (rawPublic) => {
  const blob = Buffer.concat([sshText("ssh-ed25519"), sshString(rawPublic)]);
  return `ssh-ed25519 ${blob.toString("base64")}`;
};

/**
 * Mint a fresh ed25519 key and return the private half as an openssh-key-v1
 * PEM string. Unencrypted (cipher "none"): the file it lands in is already
 * 0600 and holds every other platform secret in cleartext.
 */
export const generateOpensshEd25519HostKey = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // The raw 32-byte halves live at the tail of the DER encodings: SPKI ends
  // with the 32-byte public point; PKCS#8 ends with the 32-byte seed.
  const spki = publicKey.export({ format: "der", type: "spki" });
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  const rawPublic = spki.subarray(spki.length - 32);
  const seed = pkcs8.subarray(pkcs8.length - 32);
  // OpenSSH's ed25519 private field is seed(32) || public(32).
  const rawPrivate = Buffer.concat([seed, rawPublic]);

  const keyType = "ssh-ed25519";
  const publicBlob = Buffer.concat([sshText(keyType), sshString(rawPublic)]);

  // The private section carries a matched check-int pair (proves a correct
  // decrypt — trivially here), then the key, then a comment, then 1..N
  // padding to the cipher block size (8 for "none").
  const check = randomBytes(4);
  let priv = Buffer.concat([
    check,
    check,
    sshText(keyType),
    sshString(rawPublic),
    sshString(rawPrivate),
    sshText(""), // comment
  ]);
  for (let pad = 1; priv.length % 8 !== 0; pad += 1) {
    priv = Buffer.concat([priv, Buffer.from([pad])]);
  }

  const body = Buffer.concat([
    AUTH_MAGIC,
    sshText("none"), // ciphername
    sshText("none"), // kdfname
    sshString(Buffer.alloc(0)), // kdfoptions (empty)
    (() => {
      const count = Buffer.alloc(4);
      count.writeUInt32BE(1, 0);
      return count;
    })(),
    sshString(publicBlob),
    sshString(priv),
  ]);

  const b64 = body.toString("base64");
  const wrapped = b64.match(/.{1,70}/g)?.join("\n") ?? b64;
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`;
};
