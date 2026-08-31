import { beforeEach, describe, expect, it, vi } from "vitest";

// The org table, hand-rolled like the other db-mocking suites here.
const store = vi.hoisted(() => ({
  orgs: [] as { id: string; awsExternalId: string | null }[],
  // Lets a test simulate the concurrent-first-read race: a value that appears
  // between the initial read and the conditional write.
  beforeUpdate: null as null | (() => void),
}));

vi.mock("@onecli/db", () => ({
  db: {
    organization: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        store.orgs.find((o) => o.id === where.id) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; awsExternalId: null };
        data: { awsExternalId: string };
      }) => {
        store.beforeUpdate?.();
        const org = store.orgs.find((o) => o.id === where.id);
        // The conditional write: only fires while the column is still unset,
        // which is what makes the race safe.
        if (!org || org.awsExternalId !== null) return { count: 0 };
        org.awsExternalId = data.awsExternalId;
        return { count: 1 };
      },
    },
  },
}));

const { ensureOrgAwsExternalId } = await import("./aws-external-id-service");

describe("ensureOrgAwsExternalId", () => {
  beforeEach(() => {
    store.orgs = [{ id: "org-1", awsExternalId: null }];
    store.beforeUpdate = null;
  });

  it("mints an id on first read and persists it", async () => {
    const id = await ensureOrgAwsExternalId("org-1");
    expect(id).toMatch(/^onecli-/);
    expect(store.orgs[0]!.awsExternalId).toBe(id);
  });

  it("returns the SAME id on every later read", async () => {
    // Load-bearing: the id is what the customer pinned in their IAM trust
    // policy, so re-minting would break every existing connection in the org.
    const first = await ensureOrgAwsExternalId("org-1");
    const second = await ensureOrgAwsExternalId("org-1");
    const third = await ensureOrgAwsExternalId("org-1");
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("keeps an id another writer set first (concurrent first reads)", async () => {
    // Two admins open the connect popup at once: both read null, both mint.
    // The loser must adopt the winner's value, not overwrite it.
    store.beforeUpdate = () => {
      store.orgs[0]!.awsExternalId = "onecli-winner";
      store.beforeUpdate = null;
    };

    const id = await ensureOrgAwsExternalId("org-1");
    expect(id).toBe("onecli-winner");
    expect(store.orgs[0]!.awsExternalId).toBe("onecli-winner");
  });

  it("returns empty for an unknown organization", async () => {
    expect(await ensureOrgAwsExternalId("nope")).toBe("");
  });

  it("mints a DISTINCT id per organization", async () => {
    // One external ID per customer is the whole point — a shared value would
    // let one org's trust policy accept another org's assume-role call.
    store.orgs.push({ id: "org-2", awsExternalId: null });
    const a = await ensureOrgAwsExternalId("org-1");
    const b = await ensureOrgAwsExternalId("org-2");
    expect(a).not.toBe(b);
  });
});
