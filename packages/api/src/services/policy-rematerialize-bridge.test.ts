import { describe, expect, it } from "vitest";
import type { Prisma } from "@onecli/db";
import {
  applyRematerialization,
  type PolicyRuleRow,
  type RematerializedDerivedInput,
} from "./policy-service";

// The bridge invariant ITSELF (the tx glue the staged-publish fix changed): a
// rematerialization must publish ONLY "current published customs + default +
// fresh derived" — never the draft. The stub tx deliberately KEEPS serving a
// planted STAGED draft row for any draft-status findMany, so a regression to
// the old step (e) ("snapshot the whole draft") republishes the planted row
// and fails the leak assertion. The pure halves are covered in
// policy-rematerialize.test.ts; this guards the seam that wires them.

interface CreatedRow {
  data: Record<string, unknown>;
  id: string;
}

const targetRow = (
  t: { kind: string } & Partial<PolicyRuleRow["targets"][number]>,
): PolicyRuleRow["targets"][number] => ({
  id: "t",
  ruleId: "r",
  appProvider: null,
  appTools: [],
  appConnectionScope: null,
  appConnectionId: null,
  secretId: null,
  secretScope: null,
  hostPattern: null,
  pathPattern: null,
  method: null,
  ...t,
});

let rowSeq = 0;
const publishedRow = (over: Partial<PolicyRuleRow>): PolicyRuleRow => ({
  id: `pub-${rowSeq++}`,
  scope: "project",
  organizationId: null,
  projectId: "p1",
  status: "published",
  generation: 4,
  priority: 0,
  enabled: true,
  isDefault: false,
  logicalId: `lp-${rowSeq}`,
  source: "custom",
  name: "published-custom",
  description: null,
  action: "allow",
  rateLimit: null,
  rateLimitWindow: null,
  requireApproval: false,
  conditions: null,
  createdByUserId: "user-1",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  identities: [],
  targets: [targetRow({ kind: "network", hostPattern: "kept.com" })],
  ...over,
});

/** A stub transaction capturing writes. `plantedStagedName` rides every
 * draft-status findMany — the regression bait. */
const makeTx = (plantedStagedName: string) => {
  const publishedCreates: CreatedRow[] = [];
  const draftCreates: CreatedRow[] = [];
  let idSeq = 0;
  const stub = {
    policyRuleV2: {
      deleteMany: async () => ({ count: 0 }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = `row-${idSeq++}`;
        const row = { data, id };
        if (data.status === "published") publishedCreates.push(row);
        else draftCreates.push(row);
        return { ...data, id };
      },
      update: async () => ({}),
      aggregate: async () => ({ _max: { generation: 4 } }),
      findMany: async ({
        where,
      }: {
        where: { status?: string; id?: { in: string[] } };
      }) => {
        // The regression bait: the OLD code snapshotted findMany(draft).
        if (where.status === "draft") {
          return [
            {
              ...publishedRow({}),
              id: "staged",
              status: "draft",
              generation: 0,
              name: plantedStagedName,
            },
          ];
        }
        // The fix's re-read of the freshly-inserted derived rows, by id.
        const ids = where.id?.in ?? [];
        return draftCreates
          .filter((c) => ids.includes(c.id))
          .map((c) => {
            const identities = c.data.identities as {
              create: Record<string, unknown>[];
            };
            const targets = c.data.targets as {
              create: ({ kind: string } & Record<string, unknown>)[];
            };
            return {
              ...c.data,
              id: c.id,
              logicalId: `ld-${c.id}`,
              // The real DB returns plain null where the write carried the
              // Prisma.JsonNull sentinel — mirror that for the signature.
              conditions: null,
              description: null,
              createdByUserId: null,
              createdAt: new Date(1),
              updatedAt: new Date(1),
              identities: identities.create.map((i, n) => ({
                id: `i${n}`,
                ruleId: c.id,
                agentId: null,
                agentGroupId: null,
                userId: null,
                groupId: null,
                ...i,
              })),
              targets: targets.create.map((t) => targetRow(t)),
            };
          });
      },
    },
  };
  // One deliberate cast, test-only: the stub implements exactly the surface
  // `applyRematerialization` touches; typing the full TransactionClient would
  // mean mocking the entire Prisma client instead.
  const tx = stub as unknown as Prisma.TransactionClient;
  return { tx, publishedCreates, draftCreates };
};

const BASE = { scope: "project", projectId: "p1" } as const;

const derivedInput = (
  name: string,
  publishPriority: number,
): RematerializedDerivedInput => ({
  priority: 0,
  publishPriority,
  isDefault: false,
  source: "blocklist",
  name,
  action: "block",
  rateLimit: null,
  rateLimitWindow: null,
  requireApproval: false,
  conditions: null,
  identities: [],
  targets: [
    {
      kind: "network",
      hostPattern: "blocked.com",
      pathPattern: null,
      method: null,
    },
  ],
});

describe("applyRematerialization (the staged-publish bridge invariant)", () => {
  it("publishes only published customs + fresh derived — a staged draft row never leaks", async () => {
    const { tx, publishedCreates } = makeTx("STAGED-EDIT-MUST-NOT-PUBLISH");
    const kept = publishedRow({ name: "keep-me", priority: 0 });
    const result = await applyRematerialization(
      tx,
      BASE,
      [derivedInput("fresh-derived", 1)],
      [],
      {
        publishedRows: [kept],
        publishedCustomPriorities: [{ id: kept.id, priority: 0 }],
      },
    );

    const names = publishedCreates.map((c) => c.data.name);
    expect(names).toContain("keep-me");
    expect(names).toContain("fresh-derived");
    expect(names).not.toContain("STAGED-EDIT-MUST-NOT-PUBLISH");
    expect(publishedCreates.every((c) => c.data.createdByUserId === null)).toBe(
      true,
    );
    expect(result.generation).toBe(5);
  });

  it("skips the publish entirely when the derived content is unchanged", async () => {
    const { tx, publishedCreates } = makeTx("STAGED-EDIT-MUST-NOT-PUBLISH");
    // The current generation already holds exactly this derived rule.
    const existingDerived = publishedRow({
      source: "blocklist",
      name: "fresh-derived",
      action: "block",
      priority: 0,
      targets: [targetRow({ kind: "network", hostPattern: "blocked.com" })],
    });
    const result = await applyRematerialization(
      tx,
      BASE,
      [derivedInput("fresh-derived", 0)],
      [],
      { publishedRows: [existingDerived], publishedCustomPriorities: [] },
    );

    expect(publishedCreates).toHaveLength(0);
    expect(result).toEqual({ generation: 4, ruleCount: 1 });
  });
});
