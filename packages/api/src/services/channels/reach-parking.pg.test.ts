import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { proofDatabaseUrl } from "../../testing/pg-proof.js";

const PROOF_URL = proofDatabaseUrl();
const P = "reach-parking-pg-";
const ORG = `${P}org`;
const WORKSPACE = `${P}workspace`;
const OWNER = `${P}owner`;
let db: typeof import("@onecli/db").db;
let reach: typeof import("./agent-reach-service");
let registry: typeof import("./registry");
let providers: typeof import("../../providers");

const clear = async () => {
  await db.agent.deleteMany({ where: { workspaceId: WORKSPACE } });
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  ({ db } = await import("@onecli/db"));
  reach = await import("./agent-reach-service");
  registry = await import("./registry");
  providers = await import("../../providers");
  await db.organization.upsert({
    where: { id: ORG },
    create: { id: ORG, name: ORG, slug: ORG },
    update: {},
  });
  await db.workspace.upsert({
    where: { id: WORKSPACE },
    create: { id: WORKSPACE, name: P, organizationId: ORG },
    update: {},
  });
  await db.user.upsert({
    where: { id: OWNER },
    create: { id: OWNER, email: `${OWNER}@example.com`, externalAuthId: OWNER },
    update: {},
  });
});

beforeEach(async () => {
  if (PROOF_URL) await clear();
});

afterAll(async () => {
  vi.restoreAllMocks();
  if (!PROOF_URL) return;
  await clear();
  await db.workspace.delete({ where: { id: WORKSPACE } });
  await db.organization.delete({ where: { id: ORG } });
  await db.user.delete({ where: { id: OWNER } });
});

const seed = async () => {
  const agent = await db.agent.create({
    data: {
      workspaceId: WORKSPACE,
      name: P,
      identifier: P,
      accessToken: `aoc_${P}`,
      kind: "hosted",
      harness: "fake",
    },
  });
  const integration = await db.channelIntegration.create({
    data: {
      organizationId: ORG,
      provider: "slack",
      externalId: "T-PARKING",
      createdByUserId: OWNER,
    },
  });
  await db.agentChannel.create({
    data: {
      agentId: agent.id,
      integrationId: integration.id,
      provider: "slack",
      externalId: "A-PARKING",
      transport: "socket",
      status: "active",
      credentials: await providers.getCrypto().encrypt('{"botToken":"fake"}'),
      createdByUserId: OWNER,
    },
  });
  const grant = await db.agentReachGrant.create({
    data: {
      agentId: agent.id,
      integrationId: integration.id,
      provider: "slack",
      subjectKind: "space",
      externalRef: "C-PARKING",
      cardRefs: [{ channel: "D-OLD", ts: "1.0", userId: OWNER }],
    },
  });
  return {
    grant,
    input: {
      grantId: grant.id,
      agentId: agent.id,
      integrationId: integration.id,
      provider: "slack" as const,
      state: "expired" as const,
      expectedRevision: grant.revision,
      cardRefs: grant.cardRefs,
      subjectLabel: grant.subjectLabel,
      externalRef: grant.externalRef,
      rewriteCards: false,
    },
  };
};

describe.skipIf(!PROOF_URL)(
  "reach parking revision fences (PostgreSQL)",
  () => {
    it("parks once and increments the revision without clearing history", async () => {
      const { grant, input } = await seed();
      expect(await reach.parkReachGrant(input)).toBe(true);
      expect(await reach.parkReachGrant(input)).toBe(false);
      const parked = await db.agentReachGrant.findUniqueOrThrow({
        where: { id: grant.id },
      });
      expect(parked).toMatchObject({
        state: "expired",
        revision: 1,
        cardRefs: grant.cardRefs,
      });
    });

    it("does not let a stale expiry overwrite a fresh authorization", async () => {
      const { grant, input } = await seed();
      await db.agentReachGrant.update({
        where: { id: grant.id },
        data: { state: "approved", revision: { increment: 1 } },
      });
      expect(await reach.parkReachGrant(input)).toBe(false);
      expect(
        await db.agentReachGrant.findUniqueOrThrow({ where: { id: grant.id } }),
      ).toMatchObject({ state: "approved", revision: 1 });
    });

    it("rejects a pending to left to pending ABA even when timestamps match", async () => {
      const { grant, input } = await seed();
      await db.agentReachGrant.update({
        where: { id: grant.id },
        data: {
          state: "left",
          revision: { increment: 1 },
          updatedAt: grant.updatedAt,
        },
      });
      await db.agentReachGrant.update({
        where: { id: grant.id },
        data: {
          state: "pending",
          revision: { increment: 1 },
          updatedAt: grant.updatedAt,
        },
      });
      expect(await reach.parkReachGrant(input)).toBe(false);
      expect(
        await db.agentReachGrant.findUniqueOrThrow({ where: { id: grant.id } }),
      ).toMatchObject({ state: "pending", revision: 2 });
    });

    it("fences parking by the captured agent and integration", async () => {
      const { grant, input } = await seed();
      expect(
        await reach.parkReachGrant({ ...input, agentId: "foreign-agent" }),
      ).toBe(false);
      expect(
        await reach.parkReachGrant({
          ...input,
          integrationId: "foreign-integration",
        }),
      ).toBe(false);
      expect(
        await db.agentReachGrant.findUniqueOrThrow({ where: { id: grant.id } }),
      ).toMatchObject({ state: "pending", revision: 0 });
    });

    it("does not let a failed asynchronous approve recheck expire a newer decision", async () => {
      const { grant } = await seed();
      const facet = registry.channelProvider("slack").reach;
      if (!facet) throw new Error("Slack reach facet required");
      const verify = vi
        .spyOn(facet, "verifySubject")
        .mockImplementation(async () => {
          await db.agentReachGrant.update({
            where: { id: grant.id },
            data: { state: "approved", revision: { increment: 1 } },
          });
          return { ok: false, reason: "bot_not_in_channel" };
        });
      try {
        expect(
          await reach.decideReachGrant({
            grantId: grant.id,
            decision: "approved",
            deciderUserId: OWNER,
          }),
        ).toEqual({ kind: "already_settled" });
        expect(
          await db.agentReachGrant.findUniqueOrThrow({
            where: { id: grant.id },
          }),
        ).toMatchObject({ state: "approved", revision: 1 });
      } finally {
        verify.mockRestore();
      }
    });

    it.each([
      { ok: true, drift: "label" },
      { ok: false, drift: "label" },
      { ok: true, drift: "cardRefs" },
      { ok: false, drift: "cardRefs" },
      { ok: true, drift: "ABA" },
      { ok: false, drift: "ABA" },
    ] as const)(
      "refuses with retry after $drift revision drift with verify ok=$ok",
      async ({ ok, drift }) => {
        const { grant, input } = await seed();
        const facet = registry.channelProvider("slack").reach;
        if (!facet) throw new Error("Slack reach facet required");
        let signalEntered = () => {};
        let releaseVerify = () => {};
        const entered = new Promise<void>((resolve) => {
          signalEntered = resolve;
        });
        const release = new Promise<void>((resolve) => {
          releaseVerify = resolve;
        });
        const verify = vi
          .spyOn(facet, "verifySubject")
          .mockImplementation(async () => {
            signalEntered();
            await release;
            return ok
              ? { ok: true }
              : { ok: false, reason: "bot_not_in_channel" };
          });
        const settle = vi
          .spyOn(facet.card, "settle")
          .mockResolvedValue(undefined);
        const post = vi.spyOn(facet.card, "post");
        const auditsBefore = await db.auditLog.count({
          where: { workspaceId: WORKSPACE },
        });
        const deciding = reach.decideReachGrant({
          grantId: grant.id,
          decision: "approved",
          deciderUserId: OWNER,
        });
        try {
          await entered;
          if (drift === "ABA") {
            await reach.parkReachGrant({ ...input, state: "left" });
            await reach.ensureSpaceGrant({
              agentId: input.agentId,
              integrationId: input.integrationId,
              provider: "slack",
              externalRef: input.externalRef,
            });
          } else {
            await db.agentReachGrant.update({
              where: { id: grant.id },
              data: {
                revision: { increment: 1 },
                ...(drift === "label"
                  ? { subjectLabel: "Updated label" }
                  : {
                      cardRefs: [
                        { channel: "D-NEW", ts: "2.0", userId: OWNER },
                      ],
                    }),
              },
            });
          }
          const beforeRelease = await db.agentReachGrant.findUniqueOrThrow({
            where: { id: grant.id },
          });
          releaseVerify();
          expect(await deciding).toEqual({
            kind: "refused",
            message:
              "This request changed while being checked. Please try again.",
          });
          expect(
            await db.agentReachGrant.findUniqueOrThrow({
              where: { id: grant.id },
            }),
          ).toEqual(beforeRelease);
          expect(beforeRelease).toMatchObject({
            state: "pending",
            revision: drift === "ABA" ? 2 : 1,
            decidedAt: null,
            decidedByUserId: null,
          });
          expect(verify).toHaveBeenCalledTimes(1);
          expect(settle).not.toHaveBeenCalled();
          expect(post).not.toHaveBeenCalled();
          expect(
            await db.auditLog.count({ where: { workspaceId: WORKSPACE } }),
          ).toBe(auditsBefore);
        } finally {
          releaseVerify();
          await deciding;
          verify.mockRestore();
          settle.mockRestore();
          post.mockRestore();
        }
      },
    );

    it("settles only captured cards and never changes the durable grant", async () => {
      const { grant, input } = await seed();
      const facet = registry.channelProvider("slack").reach;
      if (!facet) throw new Error("Slack reach facet required");
      const settle = vi
        .spyOn(facet.card, "settle")
        .mockResolvedValue(undefined);
      try {
        expect(await reach.parkReachGrant(input)).toBe(true);
        await reach.settleParkedReachCards({
          ...input,
          expectedRevision: 1,
          rewriteCards: true,
        });
        expect(settle).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            channel: "D-OLD",
            ts: "1.0",
            outcome: "expired",
          }),
        );
        await reach.ensureSpaceGrant({
          agentId: input.agentId,
          integrationId: input.integrationId,
          provider: "slack",
          externalRef: input.externalRef,
        });
        await reach.settleParkedReachCards({
          ...input,
          expectedRevision: 1,
          rewriteCards: true,
        });
        expect(settle).toHaveBeenCalledTimes(1);
        expect(
          await db.agentReachGrant.findUniqueOrThrow({
            where: { id: grant.id },
          }),
        ).toMatchObject({ state: "pending", revision: 2, cardRefs: [] });
      } finally {
        settle.mockRestore();
      }
    });
  },
);
