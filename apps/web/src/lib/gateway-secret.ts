import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { timingSafeEqual } from "crypto";

/**
 * Gateway–API shared secret management.
 *
 * The gateway authenticates requests to `/api/gateway/*` with an `X-Gateway-Secret` header.
 * This prevents agents from calling gateway API endpoints directly.
 *
 * - **Cloud**: Both gateway and web API read `GATEWAY_SECRET` env var (from Secrets Manager).
 * - **OSS**: Web API generates the secret file on startup; gateway reads from the same file.
 */

const GATEWAY_SECRET_FILE_DOCKER = "/app/data/gateway-secret";
const GATEWAY_SECRET_FILE_LOCAL = `${process.env.HOME}/.onecli/gateway-secret`;
const SECRET_LENGTH_BYTES = 32; // 256-bit, rendered as 64 hex chars

/**
 * Determine the gateway secret file path.
 * Matches the gateway's default: `/app/data/gateway-secret` in Docker, `~/.onecli/gateway-secret` locally.
 */
const getSecretFilePath = (): string => {
  if (process.env.GATEWAY_SECRET_FILE) return process.env.GATEWAY_SECRET_FILE;
  return existsSync("/app/data")
    ? GATEWAY_SECRET_FILE_DOCKER
    : GATEWAY_SECRET_FILE_LOCAL;
};

let cachedSecret: string | null | undefined;

/**
 * Load the gateway secret.
 * Checks `GATEWAY_SECRET` env var first (cloud), then reads from file (OSS).
 */
const isCloud = process.env.NEXT_PUBLIC_EDITION === "cloud";

const loadSecret = (): string | null => {
  // Cloud: GATEWAY_SECRET env var is required
  const envSecret = process.env.GATEWAY_SECRET?.trim();
  if (envSecret) return envSecret;

  if (isCloud) {
    throw new Error(
      "GATEWAY_SECRET env var is required in cloud edition but not set",
    );
  }

  // OSS: read from file
  const path = getSecretFilePath();
  try {
    const secret = readFileSync(path, "utf-8").trim();
    return secret || null;
  } catch {
    return null;
  }
};

/**
 * Get the gateway secret, loading and caching on first call.
 * Returns null if no secret is configured.
 */
export const getGatewaySecret = (): string | null => {
  if (cachedSecret === undefined) {
    cachedSecret = loadSecret();
    // OSS: auto-generate the secret file if it doesn't exist yet
    if (!cachedSecret && !isCloud) {
      ensureGatewaySecretFile();
      cachedSecret = loadSecret();
    }
  }
  return cachedSecret;
};

/**
 * Validate the `X-Gateway-Secret` header from an incoming request.
 * Uses constant-time comparison to prevent timing attacks.
 * Returns true if the secret matches, false otherwise.
 */
export const validateGatewaySecret = (headerValue: string | null): boolean => {
  const secret = getGatewaySecret();
  if (!secret || !headerValue) return false;

  try {
    const a = Buffer.from(secret, "utf-8");
    const b = Buffer.from(headerValue, "utf-8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
};

/**
 * Ensure the gateway secret file exists. If not, generate a random secret and write it.
 * Called during OSS startup (entrypoint.sh) so the gateway can read it.
 * No-op if `GATEWAY_SECRET` env var is set (cloud mode).
 */
export const ensureGatewaySecretFile = (): void => {
  // Cloud: env var is used, no file needed
  if (process.env.GATEWAY_SECRET?.trim()) return;

  const path = getSecretFilePath();

  // Skip if file already exists with content
  try {
    const existing = readFileSync(path, "utf-8").trim();
    if (existing) return;
  } catch {
    // File doesn't exist, generate it
  }

  const secret = randomBytes(SECRET_LENGTH_BYTES).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, secret, { mode: 0o600 });

  // Clear cache so next read picks up the new secret
  cachedSecret = undefined;
};
