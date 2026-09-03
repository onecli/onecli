import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests for the AWS Marketplace lifecycle service
// (plans/aws-marketplace-listing.md) on the Concurrent Agreements standard:
// registration guards, per-license entitlement convergence (subscribe,
// concurrent licenses, churn), license-attributed idempotent overage
// metering, and deprovision final-usage handling. The DB is mocked; the
// marketplace client is the scriptable fake.

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  delete process.env.EDITION;
});

const state = vi.hoisted(() => {
  interface SubRow {
    id: string;
    organizationId: string;
    customerAwsAccountId: string;
    productCode: string;
    status: string;
    entitledAgents: number;
    contractExpiresAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }
  interface LicenseRow {
    id: string;
    subscriptionId: string;
    licenseArn: string;
    status: string;
    entitledAgents: number;
    expiresAt: Date | null;
    rawEntitlements: unknown;
  }
  interface MeteredRow {
    id: string;
    organizationId: string;
    licenseArn: string;
    dimension: string;
    quantity: number;
    contractYearStart: Date;
    quantityOrdinal: number;
    usageTimestamp: Date;
    meteringRecordId: string | null;
  }
  return {
    subs: [] as SubRow[],
    licenses: [] as LicenseRow[],
    metered: [] as MeteredRow[],
    orgUpdates: [] as Array<{ id: string; subscriptionStatus: string }>,
    nextId: 1,
  };
});

vi.mock("@onecli/db", () => ({
  db: {
    awsMarketplaceSubscription: {
      findUnique: async ({
        where,
        include,
      }: {
        where: Record<string, string>;
        include?: { licenses?: boolean };
      }) => {
        const row =
          state.subs.find((s) =>
            where.customerAwsAccountId
              ? s.customerAwsAccountId === where.customerAwsAccountId
              : where.organizationId
                ? s.organizationId === where.organizationId
                : s.id === where.id,
          ) ?? null;
        if (!row) return null;
        return include?.licenses
          ? {
              ...row,
              licenses: state.licenses.filter(
                (l) => l.subscriptionId === row.id,
              ),
            }
          : row;
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const row = state.subs.find((s) => s.id === where.id);
        if (!row) throw new Error("not found");
        return row;
      },
      findMany: async ({
        where,
        include,
      }: {
        where: { status: string | { in: string[] } };
        include?: { licenses?: { where: { status: string } } };
      }) => {
        const statuses =
          typeof where.status === "string" ? [where.status] : where.status.in;
        return state.subs
          .filter((s) => statuses.includes(s.status))
          .map((s) =>
            include?.licenses
              ? {
                  ...s,
                  licenses: state.licenses.filter(
                    (l) =>
                      l.subscriptionId === s.id &&
                      l.status === include.licenses!.where.status,
                  ),
                }
              : s,
          );
      },
      upsert: async (args: {
        where: { customerAwsAccountId: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const existing = state.subs.find(
          (s) => s.customerAwsAccountId === args.where.customerAwsAccountId,
        );
        if (existing) return existing;
        const row = {
          id: `sub-${state.nextId++}`,
          entitledAgents: 0,
          contractExpiresAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...(args.create as object),
        } as (typeof state.subs)[number];
        state.subs.push(row);
        return row;
      },
      update: async (args: {
        where: { customerAwsAccountId: string };
        data: Record<string, unknown>;
      }) => {
        const row = state.subs.find(
          (s) => s.customerAwsAccountId === args.where.customerAwsAccountId,
        );
        if (!row) throw new Error("not found");
        Object.assign(row, args.data);
        return row;
      },
    },
    awsMarketplaceLicense: {
      upsert: async (args: {
        where: { licenseArn: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const existing = state.licenses.find(
          (l) => l.licenseArn === args.where.licenseArn,
        );
        if (existing) {
          Object.assign(existing, args.update);
          return existing;
        }
        const row = {
          id: `lic-${state.nextId++}`,
          ...(args.create as object),
        } as (typeof state.licenses)[number];
        state.licenses.push(row);
        return row;
      },
      update: async (args: {
        where: { licenseArn: string };
        data: Record<string, unknown>;
      }) => {
        const row = state.licenses.find(
          (l) => l.licenseArn === args.where.licenseArn,
        );
        if (!row) throw new Error("not found");
        Object.assign(row, args.data);
        return row;
      },
      findMany: async (args: {
        where: { subscriptionId: string; status: string };
      }) =>
        state.licenses.filter(
          (l) =>
            l.subscriptionId === args.where.subscriptionId &&
            l.status === args.where.status,
        ),
    },
    awsMarketplaceMeteredRecord: {
      aggregate: async (args: {
        where: {
          organizationId: string;
          dimension: string;
          contractYearStart: Date;
        };
      }) => {
        const rows = state.metered.filter(
          (m) =>
            m.organizationId === args.where.organizationId &&
            m.dimension === args.where.dimension &&
            m.contractYearStart.getTime() ===
              args.where.contractYearStart.getTime(),
        );
        return {
          _sum: {
            quantity: rows.length
              ? rows.reduce((s, r) => s + r.quantity, 0)
              : null,
          },
        };
      },
      create: async (args: { data: Record<string, unknown> }) => {
        const row = {
          id: `met-${state.nextId++}`,
          meteringRecordId: null,
          ...(args.data as object),
        } as (typeof state.metered)[number];
        state.metered.push(row);
        return row;
      },
      update: async (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = state.metered.find((m) => m.id === args.where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, args.data);
        return row;
      },
    },
    organization: {
      updateMany: async (args: {
        where: { id: string; subscriptionStatus?: { not?: string } | string };
        data: { subscriptionStatus: string };
      }) => {
        // Mirror the guard: a downgrade write filtered to the marketplace
        // plan only applies when the org's current status matches.
        const current = state.orgUpdates.at(-1)?.subscriptionStatus ?? "free";
        const filter = args.where.subscriptionStatus;
        if (typeof filter === "string" && current !== filter) {
          return { count: 0 };
        }
        state.orgUpdates.push({
          id: args.where.id,
          subscriptionStatus: args.data.subscriptionStatus,
        });
        return { count: 1 };
      },
    },
    agent: {
      count: async () => 0,
    },
  },
}));

import {
  registerMarketplaceCustomer,
  syncEntitlements,
  meterOverages,
  handleLicenseDeprovisioned,
  pickBillingLicense,
  currentContractYearStart,
} from "./service";
import { FakeAwsMarketplaceClient, setAwsMarketplaceClient } from "./client";
import {
  AWS_MARKETPLACE_CONTRACT_DIMENSION,
  AWS_MARKETPLACE_OVERAGE_DIMENSION,
} from "./env";

let fake: FakeAwsMarketplaceClient;

const ACCOUNT = "123456789012";
const LICENSE_1 = "arn:aws:license-manager::123456789012:license:l-111";
const LICENSE_2 = "arn:aws:license-manager::123456789012:license:l-222";

const inAYear = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d;
};

beforeEach(() => {
  state.subs.length = 0;
  state.licenses.length = 0;
  state.metered.length = 0;
  state.orgUpdates.length = 0;
  fake = new FakeAwsMarketplaceClient();
  setAwsMarketplaceClient(fake);
});

const subscribeAccount = (
  account = ACCOUNT,
  agents = 10,
  licenseArn = LICENSE_1,
) => {
  const existing = fake.entitlementsByAccount.get(account) ?? [];
  fake.entitlementsByAccount.set(account, [
    ...existing,
    {
      licenseArn,
      dimension: AWS_MARKETPLACE_CONTRACT_DIMENSION,
      value: agents,
      expirationDate: inAYear(),
    },
  ]);
};

const register = (organizationId = "org-1", account = ACCOUNT) =>
  registerMarketplaceCustomer({
    organizationId,
    registrationToken: `fake:${account}:${LICENSE_1}`,
  });

describe("registerMarketplaceCustomer", () => {
  it("links, syncs entitlements, and activates the org plan", async () => {
    subscribeAccount();
    const sub = await register();
    expect(sub.status).toBe("subscribed");
    expect(sub.entitledAgents).toBe(10);
    expect(state.licenses).toHaveLength(1);
    expect(state.licenses[0]).toMatchObject({
      licenseArn: LICENSE_1,
      status: "active",
      entitledAgents: 10,
    });
    expect(state.orgUpdates).toEqual([
      { id: "org-1", subscriptionStatus: "aws-marketplace" },
    ]);
  });

  it("rejects an invalid token as INVALID_TOKEN", async () => {
    await expect(
      registerMarketplaceCustomer({
        organizationId: "org-1",
        registrationToken: "garbage",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("rejects linking one marketplace buyer to a second org", async () => {
    subscribeAccount();
    await register("org-1");
    await expect(register("org-2")).rejects.toMatchObject({
      code: "ALREADY_LINKED",
    });
  });

  it("rejects linking a second marketplace buyer to a linked org", async () => {
    subscribeAccount(ACCOUNT);
    subscribeAccount("999999999999");
    await register("org-1", ACCOUNT);
    await expect(register("org-1", "999999999999")).rejects.toMatchObject({
      code: "ORG_ALREADY_MARKETPLACE",
    });
  });

  it("is idempotent for the same buyer + org pair", async () => {
    subscribeAccount();
    await register();
    const again = await register();
    expect(again.status).toBe("subscribed");
    expect(state.subs).toHaveLength(1);
  });
});

describe("syncEntitlements (concurrent agreements)", () => {
  it("sums entitlements across concurrent licenses", async () => {
    subscribeAccount(ACCOUNT, 10, LICENSE_1);
    subscribeAccount(ACCOUNT, 25, LICENSE_2);
    const sub = await register();
    expect(sub.entitledAgents).toBe(35);
    expect(state.licenses).toHaveLength(2);
    expect(sub.status).toBe("subscribed");
  });

  it("keeps the org subscribed while one of two licenses ends", async () => {
    subscribeAccount(ACCOUNT, 10, LICENSE_1);
    subscribeAccount(ACCOUNT, 25, LICENSE_2);
    await register();
    // License 2's agreement ends: its entitlements disappear.
    fake.entitlementsByAccount.set(
      ACCOUNT,
      fake.entitlementsByAccount
        .get(ACCOUNT)!
        .filter((e) => e.licenseArn !== LICENSE_2),
    );
    const result = await syncEntitlements(ACCOUNT);
    expect(result?.status).toBe("subscribed");
    expect(result?.entitledAgents).toBe(10);
    expect(state.licenses.find((l) => l.licenseArn === LICENSE_2)?.status).toBe(
      "deprovisioned",
    );
    expect(state.orgUpdates.at(-1)).toEqual({
      id: "org-1",
      subscriptionStatus: "aws-marketplace",
    });
  });

  it("downgrades the org to free when every license is gone", async () => {
    subscribeAccount();
    await register();
    fake.entitlementsByAccount.set(ACCOUNT, []);
    const result = await syncEntitlements(ACCOUNT);
    expect(result?.status).toBe("unsubscribed");
    expect(state.orgUpdates.at(-1)).toEqual({
      id: "org-1",
      subscriptionStatus: "free",
    });
  });

  it("adds committed extras from non-contract dimensions on a license", async () => {
    fake.entitlementsByAccount.set(ACCOUNT, [
      {
        licenseArn: LICENSE_1,
        dimension: AWS_MARKETPLACE_CONTRACT_DIMENSION,
        value: 10,
        expirationDate: inAYear(),
      },
      {
        // A committed-extras dimension from a private offer (distinct API
        // identifier; the standard overage dimension shares the contract's).
        licenseArn: LICENSE_1,
        dimension: "committed_extra_agents",
        value: 5,
        expirationDate: inAYear(),
      },
    ]);
    const sub = await register();
    expect(sub.entitledAgents).toBe(15);
  });

  it("ignores an unknown buyer without throwing", async () => {
    await expect(syncEntitlements("000000000000")).resolves.toBeNull();
  });

  it("a pending registration (no license yet) never touches the org plan", async () => {
    // Buyer reaches the landing page before AWS confirms the purchase:
    // ResolveCustomer works but GetEntitlements is empty. The link stays
    // pending and the org keeps whatever plan it had (no write).
    const sub = await register();
    expect(sub.status).toBe("pending");
    expect(state.orgUpdates).toHaveLength(0);
  });
});

describe("meterOverages", () => {
  const setup = async (agents: number) => {
    subscribeAccount();
    await register();
    return async () => agents;
  };

  it("meters nothing at or under the entitlement", async () => {
    const count = await setup(10);
    await meterOverages(count);
    expect(fake.meteredRecords).toHaveLength(0);
  });

  it("meters the delta above the entitlement once, against the license", async () => {
    const count = await setup(13);
    await meterOverages(count);
    expect(fake.meteredRecords).toEqual([
      expect.objectContaining({
        customerAwsAccountId: ACCOUNT,
        licenseArn: LICENSE_1,
        dimension: AWS_MARKETPLACE_OVERAGE_DIMENSION,
        quantity: 3,
      }),
    ]);
    expect(state.metered[0]).toMatchObject({
      licenseArn: LICENSE_1,
      quantity: 3,
      quantityOrdinal: 11,
      meteringRecordId: "fake-1",
    });
  });

  it("a second run with the same count meters nothing more (idempotent)", async () => {
    const count = await setup(13);
    await meterOverages(count);
    await meterOverages(count);
    expect(fake.meteredRecords).toHaveLength(1);
  });

  it("a later growth meters only the new delta", async () => {
    const count = await setup(13);
    await meterOverages(count);
    await meterOverages(async () => 15);
    expect(fake.meteredRecords).toHaveLength(2);
    expect(fake.meteredRecords[1]).toMatchObject({ quantity: 2 });
    expect(state.metered[1]).toMatchObject({ quantityOrdinal: 14 });
  });

  it("shrinking below the high-water mark meters nothing", async () => {
    const count = await setup(13);
    await meterOverages(count);
    await meterOverages(async () => 8);
    expect(fake.meteredRecords).toHaveLength(1);
  });

  it("bills against the license with the furthest horizon", async () => {
    subscribeAccount(ACCOUNT, 10, LICENSE_1);
    const far = new Date();
    far.setFullYear(far.getFullYear() + 2);
    fake.entitlementsByAccount.get(ACCOUNT)!.push({
      licenseArn: LICENSE_2,
      dimension: AWS_MARKETPLACE_CONTRACT_DIMENSION,
      value: 5,
      expirationDate: far,
    });
    await register();
    // Both licenses floor at 10 included agents → 20 entitled; 25 agents
    // is 5 over, billed against the furthest-horizon license.
    await meterOverages(async () => 25);
    expect(fake.meteredRecords).toEqual([
      expect.objectContaining({ licenseArn: LICENSE_2, quantity: 5 }),
    ]);
  });
});

describe("handleLicenseDeprovisioned", () => {
  it("meters final usage against the ending license, then downgrades", async () => {
    subscribeAccount();
    await register();
    fake.entitlementsByAccount.set(ACCOUNT, []);
    const result = await handleLicenseDeprovisioned({
      customerAwsAccountId: ACCOUNT,
      licenseArn: LICENSE_1,
      countAgents: async () => 13,
    });
    // Final overage (3 above the 10 entitled) billed against the ending
    // license inside the grace window, then the org downgrades.
    expect(fake.meteredRecords).toEqual([
      expect.objectContaining({ licenseArn: LICENSE_1, quantity: 3 }),
    ]);
    expect(result?.status).toBe("unsubscribed");
    expect(state.orgUpdates.at(-1)).toEqual({
      id: "org-1",
      subscriptionStatus: "free",
    });
  });

  it("keeps the remaining license active after one of two deprovisions", async () => {
    subscribeAccount(ACCOUNT, 10, LICENSE_1);
    subscribeAccount(ACCOUNT, 25, LICENSE_2);
    await register();
    fake.entitlementsByAccount.set(
      ACCOUNT,
      fake.entitlementsByAccount
        .get(ACCOUNT)!
        .filter((e) => e.licenseArn !== LICENSE_1),
    );
    const result = await handleLicenseDeprovisioned({
      customerAwsAccountId: ACCOUNT,
      licenseArn: LICENSE_1,
      countAgents: async () => 0,
    });
    expect(result?.status).toBe("subscribed");
    expect(result?.entitledAgents).toBe(25);
  });

  it("is a no-op sync for an unknown buyer", async () => {
    await expect(
      handleLicenseDeprovisioned({
        customerAwsAccountId: "000000000000",
        licenseArn: LICENSE_1,
        countAgents: async () => 0,
      }),
    ).resolves.toBeNull();
  });
});

describe("pickBillingLicense", () => {
  it("returns null for no licenses", () => {
    expect(pickBillingLicense([])).toBeNull();
  });

  it("prefers the latest expiry, treating null as furthest", () => {
    const soon = new Date();
    const later = new Date(soon.getTime() + 1000);
    expect(
      pickBillingLicense([
        { licenseArn: "a", expiresAt: soon },
        { licenseArn: "b", expiresAt: later },
      ])?.licenseArn,
    ).toBe("b");
    expect(
      pickBillingLicense([
        { licenseArn: "a", expiresAt: soon },
        { licenseArn: "c", expiresAt: null },
      ])?.licenseArn,
    ).toBe("c");
  });
});

describe("currentContractYearStart", () => {
  it("anchors on expiry minus 12 months when known", () => {
    const expires = new Date();
    expires.setMonth(expires.getMonth() + 3);
    const start = currentContractYearStart({
      createdAt: new Date("2020-01-01"),
      contractExpiresAt: expires,
    });
    const expected = new Date(expires);
    expected.setFullYear(expected.getFullYear() - 1);
    expect(start.getTime()).toBe(expected.getTime());
  });

  it("falls back to createdAt without an expiry", () => {
    const createdAt = new Date("2026-01-15");
    expect(
      currentContractYearStart({ createdAt, contractExpiresAt: null }),
    ).toBe(createdAt);
  });
});
