import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Which secret-crypto backend `ensureEditionDefaults()` installs. The rule must
 * match the gateway's `wiring::create_crypto_service` exactly: an explicit
 * SECRET_ENCRYPTION_KEY selects local AES, otherwise (cloud) KMS envelope. The
 * gateway decrypts only the format its own backend writes, so when the two
 * disagree every credential the API saves (an OAuth reconnect, a refreshed
 * token) is unreadable at injection time — the request goes out with no
 * credential and the agent sees "access revoked".
 */

const SAVED = {
  EDITION: process.env.EDITION,
  NEXT_PUBLIC_EDITION: process.env.NEXT_PUBLIC_EDITION,
  SECRET_ENCRYPTION_KEY: process.env.SECRET_ENCRYPTION_KEY,
};

const loadWith = async (env: { edition: "cloud" | "onprem"; key: string }) => {
  vi.resetModules();
  process.env.EDITION = env.edition === "cloud" ? "cloud" : "";
  process.env.NEXT_PUBLIC_EDITION = process.env.EDITION;
  process.env.SECRET_ENCRYPTION_KEY = env.key;
  const providers = await import("./crypto");
  const defaults = await import("../edition-defaults");
  const kms = await import("../ee/kms-crypto");
  const local = await import("../lib/crypto");
  defaults.ensureEditionDefaults();
  return { crypto: providers.getCrypto(), kms, local };
};

afterEach(() => {
  for (const [name, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.resetModules();
});

const KEY = Buffer.alloc(32, 7).toString("base64");

describe("secret crypto selection (parity with the gateway)", () => {
  it("cloud without SECRET_ENCRYPTION_KEY → KMS envelope", async () => {
    const { crypto, kms } = await loadWith({ edition: "cloud", key: "" });
    expect(crypto).toBe(kms.cryptoService);
  });

  it("cloud WITH SECRET_ENCRYPTION_KEY → local AES, like the gateway", async () => {
    const { crypto, local } = await loadWith({ edition: "cloud", key: KEY });
    expect(crypto).toBe(local.cryptoService);
    // The 3-part format is the one the gateway's local backend decrypts.
    expect((await crypto.encrypt("x")).split(":")).toHaveLength(3);
  });

  it("onprem → local AES", async () => {
    const { crypto, local } = await loadWith({ edition: "onprem", key: KEY });
    expect(crypto).toBe(local.cryptoService);
  });
});
