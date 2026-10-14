import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The supervisor-session credential (the resumable channel).
 *
 * A runner restart loses the single-use bootstrap tokens with the process,
 * so a supervisor could never reconnect. The fix is a credential ANY runner
 * process holding the fleet key can verify on its own: an HMAC over the
 * sandbox and its container. No shared store, no DB row, one hash per
 * verify, and a recreated container (new ref) invalidates the old one
 * automatically.
 *
 * What it authorises: exactly one sandbox's control channel, for exactly one
 * container. Never a `/v1` principal, never leaves the host network (it rides
 * the same WebSocket the bootstrap token did), and it is derived, so the
 * sandbox never sees the key itself.
 *
 * Keyring, not key: `RUNNER_SESSION_KEY` is `kid.secret[,kid.secret…]`. The
 * FIRST entry signs, EVERY entry verifies, so rotation is `new,old` → roll →
 * `new` with live sessions intact. A bare secret (a single generated
 * value) is a one-key ring under the `default` kid.
 *
 * Wire shape: `v1.<kid>.<hmac-sha256-hex>`. The version prefix is what lets
 * the message framing change later without a flag day.
 */

export interface SessionKeyring {
  /** Mint the credential for one sandbox on one container. */
  sign(sandboxId: string, containerRef: string): string;
  /** Constant-time check of a presented credential against the same facts. */
  verify(credential: string, sandboxId: string, containerRef: string): boolean;
}

const VERSION = "v1";
const DEFAULT_KID = "default";
/** A key id: short, no dots (the separator), no whitespace. */
const KID = /^[A-Za-z0-9_-]{1,32}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

interface SessionKey {
  kid: string;
  secret: Buffer;
}

/**
 * The signed message. Length-framed, not concatenated: `sign("ab", "c")` and
 * `sign("a", "bc")` must never collide, and neither input is trusted to be
 * free of the other's bytes.
 */
const message = (sandboxId: string, containerRef: string): Buffer => {
  const a = Buffer.from(sandboxId, "utf8");
  const b = Buffer.from(containerRef, "utf8");
  const header = Buffer.alloc(8);
  header.writeUInt32BE(a.length, 0);
  header.writeUInt32BE(b.length, 4);
  return Buffer.concat([header, a, b]);
};

const mac = (key: SessionKey, sandboxId: string, containerRef: string) =>
  createHmac("sha256", key.secret)
    .update(message(sandboxId, containerRef))
    .digest();

const parseEntry = (raw: string, bare: boolean): SessionKey => {
  if (bare) return { kid: DEFAULT_KID, secret: Buffer.from(raw, "utf8") };
  const dot = raw.indexOf(".");
  const kid = dot === -1 ? "" : raw.slice(0, dot);
  const secret = dot === -1 ? "" : raw.slice(dot + 1);
  if (!KID.test(kid) || secret.length === 0 || secret.includes(".")) {
    throw new Error(
      "RUNNER_SESSION_KEY entries must be `kid.secret` (kid: [A-Za-z0-9_-]{1,32}, secret: non-empty, no dots)",
    );
  }
  return { kid, secret: Buffer.from(secret, "utf8") };
};

/**
 * Parse `RUNNER_SESSION_KEY`. `null` when unset or blank: resumption is off
 * and the runner keeps its bootstrap-only behaviour. A malformed value
 * THROWS: a typo must fail the boot loudly, never silently disable the
 * feature the operator believes is on.
 */
export const parseSessionKeyring = (
  raw: string | undefined,
): SessionKeyring | null => {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return null;

  const entries = trimmed.split(",").map((entry) => entry.trim());
  const bare = entries.length === 1 && !entries[0]!.includes(".");
  const keys = entries.map((entry) => parseEntry(entry, bare));

  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key.kid)) {
      throw new Error(`RUNNER_SESSION_KEY has a duplicate kid: ${key.kid}`);
    }
    seen.add(key.kid);
  }
  const byKid = new Map(keys.map((key) => [key.kid, key]));
  const signer = keys[0]!;

  return {
    sign: (sandboxId, containerRef) =>
      `${VERSION}.${signer.kid}.${mac(signer, sandboxId, containerRef).toString("hex")}`,

    verify: (credential, sandboxId, containerRef) => {
      const [version, kid, hex, ...rest] = credential.split(".");
      if (version !== VERSION || rest.length > 0 || !kid || !hex) return false;
      if (!HEX_64.test(hex)) return false;
      const key = byKid.get(kid);
      if (!key) return false;
      const expected = mac(key, sandboxId, containerRef);
      const presented = Buffer.from(hex, "hex");
      return (
        presented.length === expected.length &&
        timingSafeEqual(presented, expected)
      );
    },
  };
};
