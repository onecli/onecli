import { afterEach, describe, expect, it, vi } from "vitest";

// Proof the standalone api-server can authenticate self-hosted browsers: a
// better-auth session becomes the SessionUser shape the auth middleware
// resolves by externalAuthId, and anything short of that is anonymous.
//
// The mapping is what is pinned here; that a REAL better-auth cookie survives
// the round trip is proven against a real database in the `.pg` sibling —
// mocking the library could only ever prove this file agrees with itself.

const SECRET = "test-better-auth-secret-test-better-auth-secret";

/** What the mocked better-auth instance answers with on the next call. */
let sessionResult: unknown = null;
let sessionError: Error | null = null;
let buildError: Error | null = null;

vi.mock("./better-auth", async () => {
  const actual =
    await vi.importActual<typeof import("./better-auth")>("./better-auth");
  return {
    ...actual,
    getOnpremAuth: () => {
      if (buildError) throw buildError;
      return {
        api: {
          getSession: async () => {
            if (sessionError) throw sessionError;
            return sessionResult;
          },
        },
      };
    },
  };
});

const loadProvider = async () => {
  vi.resetModules();
  const mod = await import("./onprem-session-provider");
  return mod.onpremSessionProvider;
};

const request = () => new Request("http://localhost:10256/v1/user");

afterEach(() => {
  vi.unstubAllEnvs();
  sessionResult = null;
  sessionError = null;
  buildError = null;
});

describe("onprem session provider", () => {
  it("resolves the identity as externalAuthId, not better-auth's own user id", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
    const provider = await loadProvider();

    sessionResult = {
      user: {
        id: "better-auth-row-id",
        email: "user@example.com",
        name: "U",
        emailVerified: true,
        externalAuthId: "ba:external-1",
      },
    };

    // The whole point: downstream (auth middleware, gateway) resolves users by
    // externalAuthId, so returning better-auth's row id would authenticate
    // nobody.
    await expect(provider.getSession(request())).resolves.toEqual({
      id: "ba:external-1",
      email: "user@example.com",
      name: "U",
      emailVerified: true,
    });
  });

  it("a user row with no externalAuthId is not authenticated", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
    const provider = await loadProvider();

    sessionResult = {
      user: { id: "row-id", email: "user@example.com", emailVerified: true },
    };

    await expect(provider.getSession(request())).resolves.toBeNull();
  });

  it("no session and unreadable cookies are anonymous, not errors", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
    const provider = await loadProvider();

    sessionResult = null;
    await expect(provider.getSession(request())).resolves.toBeNull();

    sessionError = new Error("malformed cookie");
    await expect(provider.getSession(request())).resolves.toBeNull();
  });

  it("an unconfigured deployment authenticates NOBODY", async () => {
    // The retired local mode answered this case by signing every visitor in as
    // a fixed admin. There is no such fallback any more: a deployment that
    // cannot build an identity layer serves anonymous requests, full stop.
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    buildError = new Error("better-auth requires a secret");
    const provider = await loadProvider();

    await expect(provider.getSession(request())).resolves.toBeNull();
  });
});
