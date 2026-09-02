import { afterEach, describe, expect, it, vi } from "vitest";

// ── Org departure is FREE — and stays free ─────────────────────────────────
//
// Member departure is the deliberate free escape from the otherwise-dark EE
// surface: a member (or a flat-team admin) removing a membership must keep
// working with the flag off, or unlicensed orgs could never shed members.
// Nothing pinned that before — someone adding assertEntitled to removeMember
// would have silently killed the escape.
//
// Behavioral, with a recording proxy db (the sso-trust style): the unlicensed
// departure path completes, the owner-block still holds (it is a domain rule,
// not a license rule), voluntary leave never revokes the login, and the
// POSITIVE CONTROL proves this harness would catch a license gate — the gated
// sibling in the same file (changeMemberRole) does throw it here.

vi.hoisted(() => {
  process.env.SECRET_ENCRYPTION_KEY ??= "test-secret";
});

const store = vi.hoisted(() => ({
  role: "member" as string,
  calls: [] as string[],
}));

// A proxy double: every model.method resolves a benign empty, recorded by
// name; targeted overrides below. Departure touches many tables — what
// matters here is which gates fire, not row plumbing.
vi.mock("@onecli/db", () => {
  const record = (name: string, value: unknown) => async () => {
    store.calls.push(name);
    return value;
  };
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => {
          if (method === "findUnique" && name === "organizationMember") {
            return record(`${name}.findUnique`, {
              role: store.role,
              userEmail: "leaver@example.com",
              user: { externalAuthId: "ext-1" },
            });
          }
          if (method === "count") return record(`${name}.count`, 1);
          if (method === "findMany") return record(`${name}.findMany`, []);
          if (method === "findFirst") return record(`${name}.findFirst`, null);
          return record(`${name}.${method}`, { count: 0 });
        },
      },
    );
  return {
    Prisma: {},
    db: new Proxy({}, { get: (_t, name: string) => model(name) }),
  };
});

import {
  changeMemberRole,
  findDeletablePersonalWorkspaces,
  listMembers,
  removeMember,
} from "../ee/services/team-service";
import { initEntitlementForTests } from "../lib/entitlements";
import { enterpriseLicenseMessage } from "../lib/entitlements-guard";

describe("org departure stays free (the deliberate escape)", () => {
  afterEach(() => {
    initEntitlementForTests(null);
    store.role = "member";
    store.calls = [];
  });

  it("unlicensed removeMember completes — never the license refusal", async () => {
    initEntitlementForTests(false);
    // Voluntary-leave shape: revokeIdentity:false ⇒ "skipped" — the leaver
    // keeps their own login, and Cognito is never consulted.
    await expect(
      removeMember("org-1", "user-2", { revokeIdentity: false }),
    ).resolves.toBe("skipped");
    // The membership row actually went — departure worked, not just no-op'd.
    expect(store.calls).toContain("organizationMember.delete");
  });

  it("the owner-block is a domain rule, alive with the flag off", async () => {
    initEntitlementForTests(false);
    store.role = "owner";
    await expect(removeMember("org-1", "user-2")).rejects.toThrow(
      "The organization owner cannot be removed",
    );
  });

  it("unlicensed listMembers answers — the flat-team page's only data source", async () => {
    // The /v1/org/members ROUTE is licensed (members_directory), so the free
    // self-host team page reads through this service via the web action
    // instead. Gating it (an easy confusion with its licensed sibling
    // listMembersPage in the same file) would blank that page — this arm is
    // what makes the documented free escape true rather than aspirational.
    initEntitlementForTests(false);
    await expect(listMembers("org-1")).resolves.toBeDefined();
  });

  it("unlicensed findDeletablePersonalWorkspaces answers — the leave dialog's warning", async () => {
    // The dialog that tells a leaver which workspaces vanish with them; a
    // license gate here would make voluntary leave silently lossy.
    initEntitlementForTests(false);
    await expect(
      findDeletablePersonalWorkspaces("org-1", "user-2"),
    ).resolves.toBeDefined();
  });

  it("positive control: the gated sibling in the same file DOES refuse here", async () => {
    // Proves this harness surfaces a license gate — so the passing arms above
    // mean removeMember truly has none, not that the mock swallowed it.
    initEntitlementForTests(false);
    await expect(changeMemberRole("org-1", "user-2", "admin")).rejects.toThrow(
      enterpriseLicenseMessage("rbac"),
    );
  });
});
