// The secrets `pnpm dev` and `pnpm run setup` provision, with one rule:
// generate what's missing, keep what's valid, and never print a value.
//
// Generation keys off the RESOLVED environment (file ∪ shell, shell wins), so
// a developer with `export RUNNER_TOKEN=…` in their shell never gets a dead
// shadowed line minted into the file.

import { randomBytes } from "node:crypto";

const base64Key = () => randomBytes(32).toString("base64");
const nonEmpty = (v) => v.trim().length > 0;

// Mirrors packages/api/src/lib/crypto.ts loadKey(): lenient base64 decode,
// exactly 32 bytes. A value this rejects (like the old `.env.example`
// placeholder) could never have encrypted anything, which is what makes
// replacing it safe — there is no ciphertext to orphan.
const decodesTo32Bytes = (v) => Buffer.from(v, "base64").length === 32;

export const SECRET_SPECS = [
  {
    key: "BETTER_AUTH_SECRET",
    generate: base64Key,
    isValid: nonEmpty,
    comment: "Signs session cookies. Losing it just signs everyone out.",
  },
  {
    key: "SECRET_ENCRYPTION_KEY",
    generate: base64Key,
    isValid: decodesTo32Bytes,
    replaceInvalid: true,
    // On the cloud edition an ABSENT key is a mode, not a gap: secret crypto
    // goes through KMS. Never mint one there — it would silently flip the
    // instance to local AES.
    skipWhenAbsent: (resolved) =>
      (resolved.EDITION ?? "").trim().toLowerCase() === "cloud",
    comment:
      "Encrypts stored secrets (AES-256-GCM). KEEP THIS: losing it orphans every stored secret.",
  },
  {
    key: "GATEWAY_INTERNAL_SECRET",
    generate: base64Key,
    isValid: nonEmpty,
    comment: "Authenticates the gateway's internal calls to the api-server.",
  },
  {
    key: "RUNNER_TOKEN",
    generate: () => `rnr_${randomBytes(32).toString("hex")}`,
    isValid: nonEmpty,
    comment:
      "The api-server blesses a runner that presents this value, so both processes must read the same one.",
  },
  {
    key: "CHANNEL_ADAPTER_TOKEN",
    generate: () => `cha_${randomBytes(32).toString("hex")}`,
    isValid: nonEmpty,
    comment: "The channel adapter's rnr_ twin: same one-value-two-processes deal.",
  },
  {
    key: "SSH_TERMINATOR_SECRET",
    generate: base64Key,
    isValid: nonEmpty,
    // The api and the ssh-terminator share this ONE value (the terminator's
    // control-plane token = the api's SSH_TERMINATOR_SECRET). Cloud injects
    // it from Secrets Manager, and the coupled SSH key material (CA key,
    // host key) is provisioned only outside cloud by ensureSshEnv — so mint
    // this only outside cloud too, or the surface half-arms (a live
    // /v1/ssh-terminator with no CA behind it).
    skipWhenAbsent: (resolved) =>
      (resolved.EDITION ?? "").trim().toLowerCase() === "cloud",
    comment:
      "Shared api↔ssh-terminator secret (the terminator's control-plane token). One value, two processes.",
  },
];

/**
 * Ensure every spec'd secret exists and is usable. Writes into `envFile` (no
 * save — the caller batches one atomic save). Returns what happened so the
 * caller can print it:
 *   generated — keys minted fresh (absent or present-empty)
 *   replaced  — keys whose existing FILE value the app provably rejects
 *   shadowedInvalid — keys whose SHELL value is invalid (we cannot fix a shell)
 */
export const ensureSecrets = (envFile, resolved, processEnv = process.env) => {
  const generated = [];
  const replaced = [];
  const shadowedInvalid = [];

  for (const spec of SECRET_SPECS) {
    const current = resolved[spec.key];
    // Whitespace-only counts as empty: it can never be a working secret, and
    // treating it as "present" would be the one path with no output at all.
    const present = current !== undefined && current.trim() !== "";
    if (present && spec.isValid(current)) continue;

    if (present) {
      if (spec.key in processEnv) {
        shadowedInvalid.push(spec.key);
        continue;
      }
      if (!spec.replaceInvalid) continue;
      envFile.upsert(spec.key, spec.generate(), { comment: spec.comment });
      replaced.push(spec.key);
      continue;
    }

    // Absent, or present-empty (an empty secret is never intentional).
    if (spec.key in processEnv) continue; // shell explicitly set it (even to "")
    if (current === undefined && spec.skipWhenAbsent?.(resolved)) continue;
    envFile.upsert(spec.key, spec.generate(), { comment: spec.comment });
    generated.push(spec.key);
  }

  return { generated, replaced, shadowedInvalid };
};

/**
 * The zero-config dev database URL — written into the file (not held as a
 * code fallback) so `pnpm db:migrate`, `dotenv -e .env` tooling and Prisma
 * itself all see the same database without the launcher in the loop. Matches
 * the postgres service `pnpm db:up` starts.
 */
export const DEV_DATABASE_URL =
  "postgresql://onecli:onecli@localhost:5432/onecli";

export const ensureDatabaseUrl = (envFile, resolved, processEnv = process.env) => {
  const current = resolved.DATABASE_URL;
  if (current !== undefined && current !== "") return false;
  if ("DATABASE_URL" in processEnv) return false;
  return envFile.upsert("DATABASE_URL", DEV_DATABASE_URL, {
    comment:
      "Local dev database — started by `pnpm db:up`, auto-started by `pnpm dev`.",
  });
};
