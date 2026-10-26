import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// lib/env captures the signing secrets at first load: pin them before any
// import evaluates.
vi.hoisted(() => {
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
  process.env.SECRET_ENCRYPTION_KEY = "test-oauth-state-secret";
});

// The edition decides what a missing OAuth client means (cloud refuses the
// platform app, a self-host mints directly): flip it per test. Onprem unless
// a test says otherwise, whatever the ambient lane.
const edition = vi.hoisted(() => ({ isCloud: false }));

vi.mock("../lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/env")>()),
  get IS_CLOUD() {
    return edition.isCloud;
  },
}));

import { githubApp } from "./github-app";
import { pkceChallenge, pkceVerifier } from "./oauth/pkce";
import {
  generateNonce,
  signOAuthState,
  verifyOAuthState,
  type OAuthStatePayload,
} from "../lib/oauth-state";
import type { OAuthExchangeCodeParams } from "./types";

// The setup redirect's `installation_id` is attacker-typed, and on the shared
// platform app one key mints tokens for every customer's installation. These
// pin the two-leg ownership proof: every platform callback detours through
// GitHub's web flow, and a token is minted only for the installation signed
// into the state, only after GitHub lists it for the user, and only in the
// browser that started the detour.

const method = githubApp.connectionMethod;
if (method.type !== "oauth" || !method.continueCallback) {
  throw new Error("expected an OAuth definition with a continuation step");
}
const continueCallback = method.continueCallback;

const PLATFORM_APP_ID = "1000";
const REDIRECT_URI = "https://api.example.com/v1/apps/github-app/callback";
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const platformCreds = {
  appId: PLATFORM_APP_ID,
  appSlug: "onecli",
  privateKey,
};

type Call = { url: string; method: string; body?: string; auth?: string };

/** GitHub, as far as these flows reach it. */
const stubGitHub = (opts: {
  userInstallations?: number[][];
  tokenOk?: boolean;
}) => {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
        auth: headers.get("authorization") ?? undefined,
      });
      if (url === "https://github.com/login/oauth/access_token") {
        return opts.tokenOk === false
          ? Response.json({ error: "bad_verification_code" })
          : Response.json({ access_token: "ghu_user" });
      }
      const page = /\/user\/installations\?per_page=100&page=(\d+)$/.exec(url);
      if (page) {
        const ids = opts.userInstallations?.[Number(page[1]) - 1] ?? [];
        return Response.json({ installations: ids.map((id) => ({ id })) });
      }
      if (url.endsWith("/token") && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      const mint = /\/app\/installations\/(\d+)\/access_tokens$/.exec(url);
      if (mint) {
        return Response.json({
          token: `ghs_${mint[1]}`,
          expires_at: "2099-01-01T00:00:00Z",
          permissions: { contents: "write" },
        });
      }
      if (/\/app\/installations\/\d+$/.test(url)) {
        return Response.json({
          account: { login: "acme", type: "Organization" },
          repository_selection: "all",
        });
      }
      if (url.startsWith("https://api.github.com/installation/repositories")) {
        return Response.json({ repositories: [], total_count: 0 });
      }
      return new Response("{}", { status: 404 });
    }),
  );
  return calls;
};

const firstLegState = (): OAuthStatePayload => ({
  workspaceId: "ws-1",
  provider: "github-app",
  nonce: generateNonce(),
  redirectPath: "/v1/apps/github-app/callback",
});

/**
 * The params the route builds for a setup redirect (leg 1) in the browser
 * that ran `/authorize`: the signed state rides the query and the cookie.
 */
const setupRedirect = (
  installationId: string,
  extra: Record<string, string> = {},
): OAuthExchangeCodeParams => {
  const signed = signOAuthState(firstLegState());
  return {
    appCredentials: platformCreds,
    callbackParams: {
      installation_id: installationId,
      state: signed,
      ...extra,
    },
    redirectUri: REDIRECT_URI,
    state: verifyOAuthState(signed)!,
    stateCookie: signed,
  };
};

/** Leg 1, then the params of GitHub's return to the callback (leg 2). */
const secondLeg = async (
  installationId: string,
  overrides: {
    callbackParams?: Record<string, string>;
    stateCookie?: string | null;
  } = {},
): Promise<OAuthExchangeCodeParams> => {
  const continuation = await continueCallback(setupRedirect(installationId));
  if (!continuation) throw new Error("expected a continuation");
  return {
    appCredentials: platformCreds,
    callbackParams: {
      code: "user-code",
      state: continuation.state,
      ...overrides.callbackParams,
    },
    redirectUri: REDIRECT_URI,
    state: verifyOAuthState(continuation.state)!,
    stateCookie:
      overrides.stateCookie === null
        ? undefined
        : (overrides.stateCookie ?? continuation.state),
  };
};

describe("github-app platform callback: ownership proof", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_APP_ID", PLATFORM_APP_ID);
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.client");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "s3cret");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("leg 1 detours every setup redirect through GitHub's web flow with PKCE", async () => {
    const calls = stubGitHub({});
    // An update redirect: GitHub sends no user code here.
    const continuation = await continueCallback(
      setupRedirect("111", { setup_action: "update" }),
    );

    const url = new URL(continuation!.continueAt);
    expect(url.origin + url.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("Iv1.client");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("state")).toBe(continuation!.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      await pkceChallenge(await pkceVerifier(continuation!.state)),
    );
    // The id now rides the signed state, alongside everything leg 1 carried.
    expect(verifyOAuthState(continuation!.state)).toMatchObject({
      workspaceId: "ws-1",
      redirectPath: "/v1/apps/github-app/callback",
      githubInstallationId: "111",
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses a non-numeric installation id before any GitHub call", async () => {
    const calls = stubGitHub({});
    await expect(continueCallback(setupRedirect("1/../../x"))).rejects.toThrow(
      "Invalid GitHub installation",
    );
    expect(calls).toHaveLength(0);
  });

  it("leg 2 mints for an installation the user can access, found on a later page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => i + 1);
    const calls = stubGitHub({ userInstallations: [firstPage, [5000]] });

    const result = await method.exchangeCode(await secondLeg("5000"));

    expect(result.credentials).toMatchObject({
      type: "github_app",
      installation_id: "5000",
      access_token: "ghs_5000",
    });
    const exchange = calls.find(
      (c) => c.url === "https://github.com/login/oauth/access_token",
    )!;
    const sent = JSON.parse(exchange.body!) as Record<string, string>;
    expect(sent).toMatchObject({
      client_id: "Iv1.client",
      client_secret: "s3cret",
      code: "user-code",
      redirect_uri: REDIRECT_URI,
    });
    expect(sent.code_verifier).toBeTruthy();
    // Listed with the user token as a Bearer, both pages read.
    const listed = calls.filter((c) => c.url.includes("/user/installations"));
    expect(listed.map((c) => c.auth)).toEqual([
      "Bearer ghu_user",
      "Bearer ghu_user",
    ]);
  });

  it("mints for the installation signed into the state, never one swapped into the query", async () => {
    const calls = stubGitHub({ userInstallations: [[111]] });
    const params = await secondLeg("111", {
      callbackParams: { installation_id: "999" },
    });

    const result = await method.exchangeCode(params);

    expect(result.credentials).toMatchObject({ installation_id: "111" });
    expect(calls.some((c) => c.url.includes("/installations/999"))).toBe(false);
  });

  it("refuses an installation the user cannot access, and still revokes the user token", async () => {
    const calls = stubGitHub({ userInstallations: [[111, 222]] });

    await expect(method.exchangeCode(await secondLeg("999"))).rejects.toThrow(
      "You don't have access to this GitHub installation.",
    );

    expect(calls.some((c) => c.url.includes("/access_tokens"))).toBe(false);
    const revoke = calls.find((c) => c.method === "DELETE");
    expect(revoke).toMatchObject({
      url: "https://api.github.com/applications/Iv1.client/token",
      auth: `Basic ${Buffer.from("Iv1.client:s3cret").toString("base64")}`,
    });
    expect(JSON.parse(revoke!.body!)).toEqual({ access_token: "ghu_user" });
  });

  it("refuses leg 2 in a browser that did not run leg 1", async () => {
    const calls = stubGitHub({ userInstallations: [[111]] });

    const otherBrowser = await secondLeg("111", {
      stateCookie: signOAuthState(firstLegState()),
    });
    await expect(method.exchangeCode(otherBrowser)).rejects.toThrow(
      /did not confirm/,
    );
    const noCookie = await secondLeg("111", { stateCookie: null });
    await expect(method.exchangeCode(noCookie)).rejects.toThrow(
      /did not confirm/,
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses leg 2 when the user declined or GitHub sent no code", async () => {
    const calls = stubGitHub({ userInstallations: [[111]] });

    const declined = await secondLeg("111", {
      callbackParams: { error: "access_denied", code: "" },
    });
    await expect(method.exchangeCode(declined)).rejects.toThrow(
      /did not confirm/,
    );
    expect(calls).toHaveLength(0);
  });

  it("shows only the fixed refusal when GitHub cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed: connect ECONNREFUSED 10.0.0.1:443");
      }),
    );

    const failure = method.exchangeCode(await secondLeg("111"));

    await expect(failure).rejects.toThrow(/did not confirm/);
    await expect(failure).rejects.not.toThrow(/ECONNREFUSED/);
  });

  it("refuses leg 2 when GitHub rejects the code", async () => {
    const calls = stubGitHub({ tokenOk: false, userInstallations: [[111]] });

    await expect(method.exchangeCode(await secondLeg("111"))).rejects.toThrow(
      /did not confirm/,
    );
    expect(calls.some((c) => c.url.includes("/access_tokens"))).toBe(false);
  });

  it("never mints straight from a setup redirect, even with a code and a matching cookie", async () => {
    const calls = stubGitHub({ userInstallations: [[111]] });
    // Everything leg 2 checks is present except the id leg 1 signs into the
    // state: the query's id must never be what gets minted.
    await expect(
      method.exchangeCode(setupRedirect("111", { code: "install-time-code" })),
    ).rejects.toThrow(/did not confirm/);
    expect(calls).toHaveLength(0);
  });

  it("refuses to start leg 1 in a browser that did not run /authorize", async () => {
    // A crafted link carrying the attacker's own state: GitHub skips consent
    // for an already-authorized victim, so this must stop at leg 1.
    const calls = stubGitHub({ userInstallations: [[111]] });

    const noCookie = { ...setupRedirect("111"), stateCookie: undefined };
    await expect(continueCallback(noCookie)).rejects.toThrow(/did not confirm/);
    const otherCookie = {
      ...setupRedirect("111"),
      stateCookie: signOAuthState(firstLegState()),
    };
    await expect(continueCallback(otherCookie)).rejects.toThrow(
      /did not confirm/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("github-app callback without the platform OAuth client", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_APP_ID", PLATFORM_APP_ID);
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    edition.isCloud = false;
  });

  it("a self-host mints directly: its platform app is the operator's own", async () => {
    stubGitHub({});

    expect(await continueCallback(setupRedirect("111"))).toBeNull();
    const result = await method.exchangeCode(setupRedirect("111"));
    expect(result.credentials).toMatchObject({ installation_id: "111" });
  });

  it("cloud refuses the platform app at both legs, before any GitHub call", async () => {
    // Fail closed: cloud deploys should make this unreachable, but one key
    // mints for every customer, so an unproven installation_id is never
    // minted.
    edition.isCloud = true;
    const calls = stubGitHub({});

    await expect(continueCallback(setupRedirect("111"))).rejects.toThrow(
      "Connecting the GitHub App isn't available right now. Please contact support.",
    );
    await expect(method.exchangeCode(setupRedirect("111"))).rejects.toThrow(
      "isn't available right now",
    );
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["a self-host without the platform client", false, false],
    ["cloud without the platform client", true, false],
    ["cloud with the platform client", true, true],
  ])(
    "%s connects a customer's own (BYOC) GitHub App without the proof",
    async (_label, isCloud, withClient) => {
      edition.isCloud = isCloud;
      if (withClient) {
        vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.client");
        vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "s3cret");
      }
      const calls = stubGitHub({});
      const byoc = {
        ...setupRedirect("111"),
        appCredentials: { ...platformCreds, appId: "42" },
      };

      expect(await continueCallback(byoc)).toBeNull();
      const result = await method.exchangeCode(byoc);
      expect(result.credentials).toMatchObject({ installation_id: "111" });
      expect(calls.some((c) => c.url.includes("/user/installations"))).toBe(
        false,
      );
    },
  );

  it("cloud with the client configured still runs the proof (no refusal)", async () => {
    edition.isCloud = true;
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.client");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "s3cret");
    stubGitHub({});

    const continuation = await continueCallback(setupRedirect("111"));
    expect(new URL(continuation!.continueAt).pathname).toBe(
      "/login/oauth/authorize",
    );
  });

  it("still refuses a non-numeric installation id", async () => {
    const calls = stubGitHub({});
    await expect(
      method.exchangeCode(setupRedirect("1/../../x")),
    ).rejects.toThrow("Invalid GitHub installation");
    expect(calls).toHaveLength(0);
  });
});
