import { beforeEach, describe, expect, it, vi } from "vitest";

// The upgrade path rewrites a user row and deletes another one, so what is
// asserted here is mostly what it REFUSES to do. Each condition gets its own
// test: every one of them is the only thing standing between "the operator
// gets their instance back" and "somebody else's account absorbs it".
//
// The move itself — foreign keys, cascades, the row lock — is proven against
// real PostgreSQL in the `.pg` sibling; a mocked client would only agree with
// this file.

const edition = vi.hoisted(() => ({ isCloud: false }));

vi.mock("./env", async () => {
  const actual = await vi.importActual<typeof import("./env")>("./env");
  return {
    ...actual,
    get IS_CLOUD() {
      return edition.isCloud;
    },
  };
});

import { adoptLegacyInstall } from "./legacy-adoption";
import {
  LEGACY_LOCAL_AUTH_ID,
  LEGACY_LOCAL_EMAIL,
} from "./legacy-local-identity";

const SESSION_ID = "ba:fresh-identity";

interface Fixture {
  /** Rows the locking SELECT finds. */
  locked: { id: string; email: string }[];
  userCount: number;
  legacyAccountCount: number;
  freshMembershipCount: number;
  fresh: {
    id: string;
    email: string;
    name: string | null;
    emailVerified: boolean;
    image: string | null;
    externalAuthId: string;
  } | null;
  /** Whether the pre-check finds a legacy row at all. */
  legacyExists: boolean;
}

const fixture: Fixture = {} as Fixture;

/** Every write the adoption performs, in order. */
let writes: string[] = [];

const tx = {
  $queryRaw: async () => fixture.locked,
  user: {
    count: async () => fixture.userCount,
    findUnique: async () => fixture.fresh,
    delete: async () => {
      writes.push("delete fresh user");
      return {};
    },
    update: async () => {
      writes.push("update legacy user");
      return {};
    },
  },
  account: {
    count: async () => fixture.legacyAccountCount,
    updateMany: async ({ where }: { where: { providerId?: string } }) => {
      writes.push(
        where.providerId ? "move credential account" : "move other accounts",
      );
      return {};
    },
  },
  session: {
    updateMany: async () => {
      writes.push("move sessions");
      return {};
    },
  },
  organizationMember: {
    count: async () => fixture.freshMembershipCount,
    updateMany: async () => {
      writes.push("rewrite member email");
      return {};
    },
  },
  apiKey: {
    updateMany: async () => {
      writes.push("rewrite api key email");
      return {};
    },
  },
  workspace: {
    updateMany: async () => {
      writes.push("rewrite workspace email");
      return {};
    },
  },
};

const prisma = {
  user: {
    findUnique: async () => (fixture.legacyExists ? { id: "legacy-1" } : null),
  },
  $transaction: async (fn: (client: typeof tx) => Promise<boolean>) => fn(tx),
} as unknown as Parameters<typeof adoptLegacyInstall>[1];

const adopt = () => adoptLegacyInstall(SESSION_ID, prisma);

beforeEach(() => {
  edition.isCloud = false;
  writes = [];
  Object.assign(fixture, {
    legacyExists: true,
    locked: [{ id: "legacy-1", email: LEGACY_LOCAL_EMAIL }],
    userCount: 2,
    legacyAccountCount: 0,
    freshMembershipCount: 0,
    fresh: {
      id: "fresh-1",
      email: "operator@example.test",
      name: "Operator",
      emailVerified: false,
      image: null,
      externalAuthId: SESSION_ID,
    },
  } satisfies Fixture);
});

describe("adoptLegacyInstall — the one state it runs in", () => {
  it("adopts, and moves the credential before deleting the row that owns it", async () => {
    await expect(adopt()).resolves.toBe(true);

    // Order is load-bearing: `accounts` and `sessions` cascade on the user, so
    // deleting first would take the password and the open session with it.
    expect(writes).toEqual([
      "move credential account",
      "move other accounts",
      "move sessions",
      "delete fresh user",
      "update legacy user",
      "rewrite member email",
      "rewrite api key email",
      "rewrite workspace email",
    ]);
  });

  it("costs one lookup and no transaction when there is no legacy row", async () => {
    fixture.legacyExists = false;
    await expect(adopt()).resolves.toBe(false);
    expect(writes).toEqual([]);
  });
});

describe("adoptLegacyInstall — the six conditions", () => {
  const refuses = async () => {
    await expect(adopt()).resolves.toBe(false);
    expect(writes).toEqual([]);
  };

  it("(1) never runs on cloud", async () => {
    // Cloud identities come from Cognito and there is no local mode to upgrade
    // from, so this code has no business touching a cloud database at all.
    edition.isCloud = true;
    await refuses();
  });

  it("(2) refuses unless there are exactly two users", async () => {
    fixture.userCount = 1;
    await refuses();

    fixture.userCount = 3;
    await refuses();
  });

  it("(3) refuses a legacy row whose email was changed", async () => {
    fixture.locked = [{ id: "legacy-1", email: "someone@example.test" }];
    await refuses();
  });

  it("(4) refuses a legacy row that has ever been a login", async () => {
    // A credential or a linked provider makes it somebody's real account.
    fixture.legacyAccountCount = 1;
    await refuses();
  });

  it("(5) refuses when the session's own user cannot be found", async () => {
    fixture.fresh = null;
    await refuses();
  });

  it("(5) refuses an identity this deployment did not mint", async () => {
    // Anything without the identity layer's prefix came from somewhere else —
    // a Cognito subject, a hand-inserted row — and is not a registration this
    // request just made.
    fixture.fresh = { ...fixture.fresh!, externalAuthId: "sub-from-elsewhere" };
    await refuses();
  });

  it("(5) refuses to merge a user who already has an organization", async () => {
    // This is the guard that keeps adoption from ever absorbing an established
    // account into the legacy row.
    fixture.freshMembershipCount = 1;
    await refuses();
  });

  it("(5) refuses when the session already IS the legacy row", async () => {
    // Adoption already happened, or something re-pointed the row; either way
    // there is nothing to merge and the delete would remove the only user.
    fixture.fresh = { ...fixture.fresh!, id: "legacy-1" };
    await refuses();
  });

  it("(6) refuses when the lock finds nothing — the losing side of a race", async () => {
    // The winner rewrote `external_auth_id` while this transaction waited, so
    // the locking SELECT's predicate no longer matches any row.
    fixture.locked = [];
    await refuses();
  });
});

describe("adoptLegacyInstall — what it rewrites", () => {
  it("takes the registration's identity rather than minting a new one", async () => {
    // The browser is already holding a cookie for this session. Giving the
    // legacy row the SAME externalAuthId is what makes that cookie resolve to
    // it immediately, with no relink and no identity conflict downstream.
    const updates: unknown[] = [];
    const spy = {
      ...tx,
      user: {
        ...tx.user,
        update: async (args: unknown) => {
          updates.push(args);
          return {};
        },
      },
    };
    const spied = {
      user: { findUnique: async () => ({ id: "legacy-1" }) },
      $transaction: async (fn: (c: typeof spy) => Promise<boolean>) => fn(spy),
    } as unknown as Parameters<typeof adoptLegacyInstall>[1];

    await expect(adoptLegacyInstall(SESSION_ID, spied)).resolves.toBe(true);
    expect(updates).toEqual([
      {
        where: { id: "legacy-1" },
        data: {
          email: "operator@example.test",
          name: "Operator",
          emailVerified: false,
          image: null,
          externalAuthId: SESSION_ID,
        },
      },
    ]);
  });

  it("looks the legacy row up by the retired identity, not by email", async () => {
    // `local-admin` is the unforgeable half: exactly one now-deleted function
    // ever wrote it, and it is unique-constrained.
    expect(LEGACY_LOCAL_AUTH_ID).toBe("local-admin");
    expect(LEGACY_LOCAL_EMAIL).toBe("admin@localhost");
  });
});
