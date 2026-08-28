import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";

// The service self-disables off-cloud — pin the cloud edition + a pool id so
// the guards let the mocked Cognito calls through.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  process.env.COGNITO_USER_POOL_ID = "pool-1";
});

const state = vi.hoisted(() => ({
  connection: null as { cognitoProviderName: string } | null,
  user: null as { deactivatedAt: Date | null } | null,
  userUpdates: [] as Record<string, unknown>[],
}));

vi.mock("@onecli/db", () => ({
  db: {
    organizationSsoConnection: {
      findFirst: async () => state.connection,
    },
    user: {
      findUnique: async () => state.user,
      update: async (args: Record<string, unknown>) => {
        state.userUpdates.push(args);
        return args;
      },
    },
  },
}));

import {
  resolveCognitoUser,
  revokeUserAccess,
  restoreUserAccess,
} from "./cognito-user-service";

const PROVIDER = "org-0f9b2c4d6e8a0b1c2d3e4f5a";

/** A fake SDK client recording command names in order. */
const makeClient = (opts?: {
  users?: Array<{
    Username: string;
    Attributes?: Array<{ Name: string; Value: string }>;
  }>;
  failWith?: Error;
}) => {
  const calls: string[] = [];
  const client = {
    send: vi.fn(async (command: { constructor: { name: string } }) => {
      const name = command.constructor.name;
      calls.push(name);
      if (opts?.failWith && name !== "ListUsersCommand") {
        throw opts.failWith;
      }
      if (name === "ListUsersCommand") {
        return { Users: opts?.users ?? [] };
      }
      return {};
    }),
  } as unknown as CognitoIdentityProviderClient;
  return { client, calls };
};

const FEDERATED_USER = {
  Username: `${PROVIDER}_okta-subject-1`,
  Attributes: [
    {
      Name: "identities",
      Value: JSON.stringify([
        { providerName: PROVIDER, userId: "okta-subject-1" },
      ]),
    },
  ],
};

const REVOKE_PARAMS = {
  userId: "user-1",
  externalAuthId: "sub-uuid-1",
  organizationId: "org-1",
  membershipCount: 1,
};

beforeEach(() => {
  state.connection = { cognitoProviderName: PROVIDER };
  state.user = { deactivatedAt: null };
  state.userUpdates = [];
});

describe("resolveCognitoUser", () => {
  it("resolves sub → username + provider names via ListUsers", async () => {
    const { client } = makeClient({ users: [FEDERATED_USER] });
    await expect(resolveCognitoUser("sub-uuid-1", client)).resolves.toEqual({
      username: `${PROVIDER}_okta-subject-1`,
      providerNames: [PROVIDER],
    });
  });

  it("refuses filter-breaking characters instead of interpolating them", async () => {
    const { client, calls } = makeClient();
    await expect(
      resolveCognitoUser('evil" or sub = "x', client),
    ).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null when no profile matches", async () => {
    const { client } = makeClient({ users: [] });
    await expect(resolveCognitoUser("sub-uuid-1", client)).resolves.toBeNull();
  });
});

describe("revokeUserAccess", () => {
  it("disables an org-owned identity: sign-out BEFORE disable, then deactivatedAt", async () => {
    const { client, calls } = makeClient({ users: [FEDERATED_USER] });
    await expect(revokeUserAccess(REVOKE_PARAMS, client)).resolves.toBe(
      "disabled",
    );
    expect(calls).toEqual([
      "ListUsersCommand",
      "AdminUserGlobalSignOutCommand",
      "AdminDisableUserCommand",
    ]);
    expect(state.userUpdates[0]).toMatchObject({
      where: { id: "user-1" },
      data: { deactivatedAt: expect.any(Date) },
    });
  });

  it("multi-org users get membership-level suspension only", async () => {
    const { client, calls } = makeClient({ users: [FEDERATED_USER] });
    await expect(
      revokeUserAccess({ ...REVOKE_PARAMS, membershipCount: 2 }, client),
    ).resolves.toBe("membership_only");
    expect(calls).toHaveLength(0);
  });

  it("identities without the org's provider (e.g. Google-only) are not org-owned", async () => {
    const { client, calls } = makeClient({
      users: [
        {
          Username: "google_123",
          Attributes: [
            {
              Name: "identities",
              Value: JSON.stringify([
                { providerName: "Google", userId: "123" },
              ]),
            },
          ],
        },
      ],
    });
    await expect(revokeUserAccess(REVOKE_PARAMS, client)).resolves.toBe(
      "membership_only",
    );
    expect(calls).toEqual(["ListUsersCommand"]);
  });

  it("orgs without an SSO connection never own identities", async () => {
    state.connection = null;
    const { client, calls } = makeClient({ users: [FEDERATED_USER] });
    await expect(revokeUserAccess(REVOKE_PARAMS, client)).resolves.toBe(
      "membership_only",
    );
    expect(calls).toHaveLength(0);
  });

  it("skips placeholder externalAuthIds without calling Cognito", async () => {
    const { client, calls } = makeClient();
    for (const id of ["provision-y", "scim-z", "local-admin"]) {
      await expect(
        revokeUserAccess({ ...REVOKE_PARAMS, externalAuthId: id }, client),
      ).resolves.toBe("skipped");
    }
    expect(calls).toHaveLength(0);
  });

  it("skips when the Cognito profile is already gone", async () => {
    const { client } = makeClient({ users: [] });
    await expect(revokeUserAccess(REVOKE_PARAMS, client)).resolves.toBe(
      "skipped",
    );
  });

  it("never throws — Cognito errors become 'failed' and the DB flip stands", async () => {
    const { client } = makeClient({
      users: [FEDERATED_USER],
      failWith: Object.assign(new Error("boom"), {
        name: "InternalErrorException",
      }),
    });
    await expect(revokeUserAccess(REVOKE_PARAMS, client)).resolves.toBe(
      "failed",
    );
    expect(state.userUpdates).toHaveLength(0);
  });
});

describe("restoreUserAccess", () => {
  it("skips users that were never deactivated", async () => {
    state.user = { deactivatedAt: null };
    const { client, calls } = makeClient();
    await expect(
      restoreUserAccess(
        { userId: "user-1", externalAuthId: "sub-uuid-1" },
        client,
      ),
    ).resolves.toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  it("re-enables + clears deactivatedAt", async () => {
    state.user = { deactivatedAt: new Date() };
    const { client, calls } = makeClient({ users: [FEDERATED_USER] });
    await expect(
      restoreUserAccess(
        { userId: "user-1", externalAuthId: "sub-uuid-1" },
        client,
      ),
    ).resolves.toBe("enabled");
    expect(calls).toEqual(["ListUsersCommand", "AdminEnableUserCommand"]);
    expect(state.userUpdates[0]).toMatchObject({
      data: { deactivatedAt: null },
    });
  });

  it("clears the flag even when the profile is gone", async () => {
    state.user = { deactivatedAt: new Date() };
    const { client } = makeClient({ users: [] });
    await expect(
      restoreUserAccess(
        { userId: "user-1", externalAuthId: "sub-uuid-1" },
        client,
      ),
    ).resolves.toBe("skipped");
    expect(state.userUpdates[0]).toMatchObject({
      data: { deactivatedAt: null },
    });
  });
});
