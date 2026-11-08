/**
 * Proof for the three Contacts migrations, run in order against seeded
 * legacy rows:
 *   1. `20261021114928_retire_members_only_reach`
 *   2. `20261021152930_one_person_setting`
 *   3. `20261024142204_drop_agent_contacts`
 *
 * The proof database is already migrated, so the pre-migration world (the
 * `agent_contacts` table, legacy state values) cannot exist in it. Each run
 * therefore rebuilds it inside ONE transaction (the table exactly as
 * `20260906235733_agent_contacts` created it), applies the three files'
 * statements, snapshots the result and rolls everything back: DDL is
 * transactional in Postgres, so nothing leaks to the shared database.
 *
 * What it pins (the owner's decisions survive, nothing is widened by
 * accident):
 *  - a retired "OneCLI users" channel (`members_only` / `denied` /
 *    `revoked`) becomes `approved`; a person row in those states becomes
 *    `blocked`; every changed row's revision moves;
 *  - a person label loses ONE leading "@" (and a bare "@" is left alone);
 *  - a blocked person contact makes the person Never, even over an approved
 *    row; an allowed contact opens an undecided row but never lifts a block;
 *    a decided contact with no row gets one on the agent's presence; an
 *    `ask` contact creates nothing;
 *  - a blocked channel contact closes that channel's row (and resets what
 *    it hears to mentions);
 *  - agent pairs still on `ask` stay on `ask`: nobody approved them;
 *  - another agent's rows are untouched;
 *  - the address book is gone afterwards.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { proofDatabaseUrl } from "../../testing/pg-proof.js";

const PROOF_URL = proofDatabaseUrl();

// Loaded in `beforeAll`, after DATABASE_URL points at the proof database:
// the module constructs the Prisma client on import.
let db: (typeof import("@onecli/db"))["db"];

const migrationFile = (name: string) =>
  join(
    dirname(fileURLToPath(import.meta.url)),
    `../../../../db/prisma/migrations/${name}/migration.sql`,
  );

/** The address book as it stood before these migrations. */
const LEGACY_TABLE = migrationFile("20260906235733_agent_contacts");

const MIGRATIONS = [
  "20261021114928_retire_members_only_reach",
  "20261021152930_one_person_setting",
  "20261024142204_drop_agent_contacts",
].map(migrationFile);

/** A migration file as separate statements (`$executeRawUnsafe` runs one at
 * a time). Comment lines and block comments go first; no statement holds a
 * `;` in a literal. */
const statementsOf = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");

const P = "cmig-";
const ORG = `${P}org`;
const WORKSPACE = `${P}ws`;
const DECIDER = `${P}decider`;
const AGENT = `${P}agent`;
const OTHER_AGENT = `${P}other`;
const PEER = `${P}peer`;

interface Snapshot {
  reach: {
    agentId: string;
    subjectKind: string;
    externalRef: string;
    subjectLabel: string | null;
    state: string;
    listen: string;
    revision: number;
    decidedByUserId: string | null;
  }[];
  links: { policyA: string; policyB: string }[];
  /** Whether `agent_contacts` still exists after the migrations. */
  addressBookLeft: boolean;
}

/** Thrown to roll the proof transaction back once the snapshot is taken. */
class RolledBack extends Error {}

const migrateSeededWorld = async (): Promise<Snapshot> => {
  let snapshot: Snapshot = { reach: [], links: [], addressBookLeft: true };
  await expect(
    db.$transaction(
      async (tx) => {
        for (const statement of statementsOf(LEGACY_TABLE)) {
          await tx.$executeRawUnsafe(statement);
        }
        await tx.organization.create({
          data: { id: ORG, name: ORG, slug: ORG },
        });
        await tx.workspace.create({
          data: { id: WORKSPACE, name: WORKSPACE, organizationId: ORG },
        });
        await tx.user.create({
          data: {
            id: DECIDER,
            email: `${DECIDER}@example.com`,
            externalAuthId: DECIDER,
            name: "Fictional Decider",
          },
        });
        for (const id of [AGENT, OTHER_AGENT, PEER]) {
          await tx.agent.create({
            data: {
              id,
              identifier: id,
              name: id,
              accessToken: `aoc_${id}`,
              workspaceId: WORKSPACE,
              kind: "hosted",
              harness: "fake",
            },
          });
        }
        const integration = await tx.channelIntegration.create({
          data: {
            organizationId: ORG,
            provider: "slack",
            externalId: `${P}T1`,
          },
          select: { id: true },
        });
        for (const [agentId, n] of [
          [AGENT, 1],
          [OTHER_AGENT, 2],
        ] as const) {
          await tx.agentChannel.create({
            data: {
              agentId,
              integrationId: integration.id,
              provider: "slack",
              externalId: `${P}A${n}`,
              identityRef: `${P}UBOT${n}`,
              transport: "socket",
              status: "active",
            },
          });
        }

        const reach = (
          agentId: string,
          subjectKind: "space" | "external_user",
          externalRef: string,
          state: string,
          extra: { subjectLabel?: string; listen?: string } = {},
        ) =>
          tx.agentReachGrant.create({
            data: {
              agentId,
              integrationId: integration.id,
              provider: "slack",
              subjectKind,
              externalRef,
              state,
              subjectLabel: extra.subjectLabel ?? externalRef,
              listen: extra.listen ?? "mentions",
            },
          });
        let contactSeq = 0;
        const contact = (
          kind: "person" | "channel",
          externalRef: string,
          policy: "ask" | "allow" | "blocked",
        ) => {
          contactSeq += 1;
          // Raw SQL: the model is gone from this version's client.
          return tx.$executeRaw`
            INSERT INTO "agent_contacts" ("id", "agent_id", "kind",
              "external_ref", "display_name", "policy",
              "decided_by_user_id", "updated_at")
            VALUES (${`${P}c${contactSeq}`}, ${AGENT}, ${kind}, ${externalRef},
              ${`Name ${externalRef}`}, ${policy}, ${DECIDER}, now())`;
        };

        // Migration 1: the retired channel setting, in all three spellings.
        await reach(AGENT, "space", "C-MEMBERS", "members_only");
        await reach(AGENT, "space", "C-DENIED", "denied");
        await reach(AGENT, "space", "C-REVOKED", "revoked");
        await reach(AGENT, "space", "C-OPEN", "approved");
        await reach(AGENT, "external_user", "U-MEMBERS", "members_only");
        await reach(AGENT, "external_user", "U-AT", "approved", {
          subjectLabel: "@Dana",
        });
        await reach(AGENT, "external_user", "U-BARE-AT", "approved", {
          subjectLabel: "@",
        });

        // Migration 2: the address book folded into the reach rows.
        await reach(AGENT, "external_user", "U-BLOCK-OVER-OPEN", "approved");
        await contact("person", "U-BLOCK-OVER-OPEN", "blocked");
        await reach(AGENT, "external_user", "U-ALLOW-PENDING", "pending");
        await contact("person", "U-ALLOW-PENDING", "allow");
        await reach(AGENT, "external_user", "U-ALLOW-NEVER", "blocked");
        await contact("person", "U-ALLOW-NEVER", "allow");
        await contact("person", "U-NEW-ALLOW", "allow");
        await contact("person", "U-NEW-BLOCK", "blocked");
        await contact("person", "U-ASK", "ask");
        await reach(AGENT, "space", "C-BLOCKED-CONTACT", "approved", {
          listen: "all",
        });
        await contact("channel", "C-BLOCKED-CONTACT", "blocked");
        await contact("channel", "C-NO-ROW", "blocked");

        // Another agent's legacy row: changed by migration 1 only.
        await reach(OTHER_AGENT, "space", "C-MEMBERS", "members_only");

        // A pair nobody answered.
        await tx.agentLink.create({
          data: { agentAId: AGENT, agentBId: PEER },
        });

        for (const file of MIGRATIONS) {
          for (const statement of statementsOf(file)) {
            await tx.$executeRawUnsafe(statement);
          }
        }

        snapshot = {
          reach: await tx.agentReachGrant.findMany({
            where: { agentId: { startsWith: P } },
            select: {
              agentId: true,
              subjectKind: true,
              externalRef: true,
              subjectLabel: true,
              state: true,
              listen: true,
              revision: true,
              decidedByUserId: true,
            },
          }),
          links: await tx.agentLink.findMany({
            where: { agentAId: { startsWith: P } },
            select: { policyA: true, policyB: true },
          }),
          addressBookLeft:
            (
              await tx.$queryRaw<{ name: string | null }[]>`
                SELECT to_regclass('public.agent_contacts')::text AS name`
            )[0]?.name != null,
        };
        throw new RolledBack();
      },
      { timeout: 30_000 },
    ),
  ).rejects.toBeInstanceOf(RolledBack);
  return snapshot;
};

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  ({ db } = await import("@onecli/db"));
});

describe.skipIf(!PROOF_URL)("the Contacts migrations", () => {
  it("retire OneCLI users, fold the address book into one setting per row, drop it, and widen nothing nobody approved", async () => {
    const { reach, links, addressBookLeft } = await migrateSeededWorld();
    const row = (ref: string, agentId: string = AGENT) => {
      const found = reach.find(
        (r) => r.agentId === agentId && r.externalRef === ref,
      );
      if (!found) throw new Error(`no row for ${ref}`);
      return found;
    };

    // 1. The retired channel setting: a channel is open, a person is Never.
    for (const ref of ["C-MEMBERS", "C-DENIED", "C-REVOKED"]) {
      expect(row(ref)).toMatchObject({ state: "approved", revision: 1 });
    }
    expect(row("C-OPEN")).toMatchObject({ state: "approved", revision: 0 });
    expect(row("U-MEMBERS")).toMatchObject({ state: "blocked", revision: 1 });
    expect(row("C-MEMBERS", OTHER_AGENT)).toMatchObject({
      state: "approved",
      revision: 1,
    });

    // One leading "@" goes; a bare "@" is not emptied.
    expect(row("U-AT")).toMatchObject({ subjectLabel: "Dana", revision: 1 });
    expect(row("U-BARE-AT").subjectLabel).toBe("@");

    // 2. A block in either place wins; an allow never lifts a Never.
    expect(row("U-BLOCK-OVER-OPEN")).toMatchObject({
      state: "blocked",
      decidedByUserId: DECIDER,
      revision: 1,
    });
    expect(row("U-ALLOW-PENDING")).toMatchObject({
      state: "approved",
      decidedByUserId: DECIDER,
      revision: 1,
    });
    expect(row("U-ALLOW-NEVER")).toMatchObject({
      state: "blocked",
      revision: 0,
    });

    // Decided contacts with no row get one, on the agent's presence.
    expect(row("U-NEW-ALLOW")).toMatchObject({
      subjectKind: "external_user",
      state: "approved",
      subjectLabel: "Name U-NEW-ALLOW",
      decidedByUserId: DECIDER,
    });
    expect(row("U-NEW-BLOCK")).toMatchObject({ state: "blocked" });
    // `ask` was never a decision: no row, so the next message asks.
    expect(reach.some((r) => r.externalRef === "U-ASK")).toBe(false);

    // A blocked channel contact closes the channel and resets what it hears.
    expect(row("C-BLOCKED-CONTACT")).toMatchObject({
      subjectKind: "space",
      state: "blocked",
      listen: "mentions",
      revision: 1,
    });
    // No channel row: nothing to fold (its first post asks the owner).
    expect(reach.some((r) => r.externalRef === "C-NO-ROW")).toBe(false);

    // Pairs nobody answered stay unanswered.
    expect(links).toEqual([{ policyA: "ask", policyB: "ask" }]);

    // 3. The address book is gone: no orphan table.
    expect(addressBookLeft).toBe(false);
  });
});
