import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Unsubscribe is token-only ───────────────────────────────────────────────
//
// The route accepts an email exclusively from the signed token minted by the
// sender. Two regressions this suite makes impossible:
//   1. the bare `?email=` fallback returning (anyone unsubscribes anyone), and
//   2. accepting tokens with UNSUBSCRIBE_TOKEN_SECRET unset (an HMAC keyed by
//      "" is computable by anyone — same attack, one step removed).

const store = vi.hoisted(() => ({
  unsubscribed: [] as string[],
}));

vi.mock("@onecli/db", () => ({
  db: {
    resendBadEmail: {
      findFirst: async () => null,
      create: async (args: { data: { email: string } }) => {
        store.unsubscribed.push(args.data.email);
        return args.data;
      },
    },
    // cancelScheduledEmails no-ops without RESEND_API_KEY; never reached here.
    resendWebhook: { findMany: async () => [] },
  },
}));

import { unsubscribeRoutes } from "./unsubscribe";
import { createUnsubscribeToken } from "../services/unsubscribe-token";

const SECRET = "unsubscribe-test-secret";

beforeEach(() => {
  store.unsubscribed = [];
  vi.stubEnv("UNSUBSCRIBE_TOKEN_SECRET", SECRET);
  // Pinned so the derivation fallback can't quietly satisfy the
  // no-key-material arms below.
  vi.stubEnv("SECRET_ENCRYPTION_KEY", "");
});

afterEach(() => vi.unstubAllEnvs());

describe("unsubscribe route (token-only)", () => {
  it("a valid token unsubscribes its email", async () => {
    const token = createUnsubscribeToken("victim@example.com");
    expect(token).not.toBeNull();
    const res = await unsubscribeRoutes().request(`/?token=${token}`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(store.unsubscribed).toEqual(["victim@example.com"]);
  });

  it("a bare ?email= is IGNORED — the anyone-unsubscribes-anyone hole stays closed", async () => {
    for (const method of ["POST", "GET"] as const) {
      const res = await unsubscribeRoutes().request(
        "/?email=victim@example.com",
        { method },
      );
      expect(res.status).toBe(200);
      expect(store.unsubscribed).toEqual([]);
    }
    // The browser arm renders the invalid-link copy, not a confirmation.
    const page = await unsubscribeRoutes().request(
      "/?email=victim@example.com",
    );
    expect(await page.text()).toContain("Invalid link");
  });

  it("GET never mutates — a link scanner's prefetch cannot suppress anyone's mail", async () => {
    // The token URL rides every email's List-Unsubscribe header, and mail
    // gateways fetch such links on delivery. A mutating GET would make one
    // prefetch (or one forwarded email) an irreversible mail lockout —
    // transactional mail included, since suppression is not scoped by type.
    const token = createUnsubscribeToken("victim@example.com");
    const page = await unsubscribeRoutes().request(`/?token=${token}`);
    expect(page.status).toBe(200);
    expect(store.unsubscribed).toEqual([]);
    const html = await page.text();
    // It offers the POST instead of having acted.
    expect(html).toContain("Unsubscribe victim@example.com?");
    expect(html).toContain('method="POST"');
  });

  it("a forged token is rejected", async () => {
    const forged = `${Buffer.from("victim@example.com").toString("base64url")}.deadbeef`;
    const res = await unsubscribeRoutes().request(`/?token=${forged}`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(store.unsubscribed).toEqual([]);
  });

  it("no key at all ⇒ an EMPTY-KEY forgery is refused (the fail-closed guard, mutation-proven)", async () => {
    // THE attack the guard exists for: with no key material, an HMAC keyed
    // by "" is computable by anyone, so this is the token an attacker mints
    // for an arbitrary address. Deleting `if (!secret) return null;` makes
    // this forgery verify — which is exactly what this test then catches.
    // (A token minted with the REAL key would fail on signature mismatch
    // instead, proving nothing about the guard.)
    vi.stubEnv("UNSUBSCRIBE_TOKEN_SECRET", "");
    vi.stubEnv("SECRET_ENCRYPTION_KEY", "");
    const payload = Buffer.from("victim@example.com").toString("base64url");
    const forged = `${payload}.${createHmac("sha256", "").update(payload).digest("hex")}`;

    const res = await unsubscribeRoutes().request(`/?token=${forged}`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(store.unsubscribed).toEqual([]);
  });

  it("minting fails closed too: no key material ⇒ no token, and the mail omits the unsubscribe URL", async () => {
    vi.stubEnv("UNSUBSCRIBE_TOKEN_SECRET", "");
    vi.stubEnv("SECRET_ENCRYPTION_KEY", "");
    expect(createUnsubscribeToken("victim@example.com")).toBeNull();
    const { buildUnsubscribeUrl } = await import("../services/email-service");
    expect(buildUnsubscribeUrl("victim@example.com")).toBeNull();
  });

  it("without an explicit secret the key is DERIVED from the encryption key — links keep working, unforgeable", async () => {
    // No deployment silently loses its one-click headers for want of one
    // more variable; the derived key is domain-separated, never the raw key.
    vi.stubEnv("UNSUBSCRIBE_TOKEN_SECRET", "");
    vi.stubEnv("SECRET_ENCRYPTION_KEY", "deployment-encryption-key");
    const token = createUnsubscribeToken("victim@example.com");
    expect(token).not.toBeNull();

    // An attacker who knows only the derivation LABEL still cannot forge:
    // the raw label keyed by "" is not the key.
    const payload = Buffer.from("victim@example.com").toString("base64url");
    const forged = `${payload}.${createHmac("sha256", "onecli:unsubscribe-token:v1").update(payload).digest("hex")}`;
    await unsubscribeRoutes().request(`/?token=${forged}`, { method: "POST" });
    expect(store.unsubscribed).toEqual([]);

    // The real derived token works.
    const res = await unsubscribeRoutes().request(`/?token=${token}`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(store.unsubscribed).toEqual(["victim@example.com"]);
  });
});
