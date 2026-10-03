import { describe, expect, it } from "vitest";
import type { SimRuleRow } from "../policy-simulate/load-rules";
import type { PrincipalSet } from "../policy-simulate/principal-set";
import {
  grantedConnectionSelection,
  grantedSecretSelection,
  providerLevelKey,
} from "./injection";

const AGENT = "agent-1";
const PRINCIPALS: PrincipalSet = { userIds: ["user-1"], groupIds: ["group-1"] };

type Target = Partial<SimRuleRow["targets"][number]> & { kind: string };
type Identity = Partial<SimRuleRow["identities"][number]>;

const rule = (over: {
  action?: string;
  isDefault?: boolean;
  identities?: Identity[];
  targets: Target[];
}): SimRuleRow =>
  ({
    action: over.action ?? "allow",
    isDefault: over.isDefault ?? false,
    identities: (over.identities ?? [{ agentId: AGENT }]).map((i) => ({
      agentId: null,
      userId: null,
      groupId: null,
      ...i,
    })),
    targets: over.targets.map((t) => ({
      appConnectionId: null,
      appProvider: null,
      appConnectionScope: null,
      secretId: null,
      secretScope: null,
      ...t,
    })),
  }) as unknown as SimRuleRow;

describe("grantedConnectionSelection", () => {
  it("collects named connections and provider-level grants for the agent", () => {
    const { ids, providerLevels } = grantedConnectionSelection(
      [
        rule({ targets: [{ kind: "connection", appConnectionId: "c1" }] }),
        rule({
          identities: [{ groupId: "group-1" }],
          targets: [
            {
              kind: "app",
              appProvider: "github",
              appConnectionScope: "organization",
            },
          ],
        }),
      ],
      AGENT,
      PRINCIPALS,
    );
    expect([...ids]).toEqual(["c1"]);
    expect([...providerLevels]).toEqual([
      providerLevelKey("github", "organization"),
    ]);
  });

  it("ignores default rules, non-allow rules, other agents, and app targets without a connection level", () => {
    const { ids, providerLevels } = grantedConnectionSelection(
      [
        rule({
          isDefault: true,
          targets: [{ kind: "connection", appConnectionId: "default" }],
        }),
        rule({
          action: "block",
          targets: [{ kind: "connection", appConnectionId: "blocked" }],
        }),
        rule({
          identities: [{ agentId: "someone-else" }],
          targets: [{ kind: "connection", appConnectionId: "foreign" }],
        }),
        // An empty identity list never matches for injection.
        rule({
          identities: [],
          targets: [{ kind: "connection", appConnectionId: "anyone" }],
        }),
        // An app target with no connection level is block/allow only.
        rule({ targets: [{ kind: "app", appProvider: "slack" }] }),
      ],
      AGENT,
      PRINCIPALS,
    );
    expect(ids.size).toBe(0);
    expect(providerLevels.size).toBe(0);
  });
});

// The grants summary and the agent's connected-apps list used to walk the
// rules inline. This replays that exact walk (copied from the pre-refactor
// grants-summary-service) against the shared helpers over random rule sets,
// so the extraction is pinned as a pure refactor.
describe("the shared selections match the pre-refactor inline walk", () => {
  const legacyWalk = (rows: SimRuleRow[]) => {
    const secretIds = new Set<string>();
    const connectionIds = new Set<string>();
    const secretLevels = new Set<string>();
    const providerLevels = new Set<string>();
    for (const row of rows) {
      if (row.isDefault || row.action !== "allow") continue;
      const named = row.identities.some((i) =>
        i.agentId != null
          ? i.agentId === AGENT
          : i.userId != null
            ? PRINCIPALS.userIds.includes(i.userId)
            : i.groupId != null
              ? PRINCIPALS.groupIds.includes(i.groupId)
              : false,
      );
      if (row.identities.length === 0 || !named) continue;
      for (const t of row.targets) {
        if (t.kind === "secret") {
          if (t.secretId) secretIds.add(t.secretId);
          else if (
            t.secretScope === "organization" ||
            t.secretScope === "workspace"
          )
            secretLevels.add(t.secretScope);
        } else if (t.kind === "connection" && t.appConnectionId) {
          connectionIds.add(t.appConnectionId);
        } else if (
          t.kind === "app" &&
          t.appProvider &&
          (t.appConnectionScope === "organization" ||
            t.appConnectionScope === "workspace")
        ) {
          providerLevels.add(`${t.appProvider}\n${t.appConnectionScope}`);
        }
      }
    }
    return { secretIds, connectionIds, secretLevels, providerLevels };
  };

  // Deterministic PRNG so a failure is reproducible.
  let seed = 1158;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const maybe = <T>(x: T): T | null => (rand() < 0.3 ? null : x);

  const randomTarget = (): Target => {
    const kind = pick(["connection", "app", "secret", "other"]);
    return {
      kind,
      appConnectionId: maybe(pick(["c1", "c2", "c3"])),
      appProvider: maybe(pick(["github", "gmail", "salesforce"])),
      appConnectionScope: maybe(pick(["organization", "workspace", "bogus"])),
      secretId: maybe(pick(["s1", "s2"])),
      secretScope: maybe(pick(["organization", "workspace", "bogus"])),
    } as Target;
  };
  const randomIdentity = (): Identity =>
    pick([
      { agentId: AGENT },
      { agentId: "other" },
      { userId: "user-1" },
      { userId: "user-2" },
      { groupId: "group-1" },
      { groupId: "group-2" },
      {},
    ]);

  it("over 2,000 random rule sets", () => {
    for (let run = 0; run < 2000; run++) {
      const rows = Array.from({ length: Math.floor(rand() * 6) }, () =>
        rule({
          action: pick(["allow", "allow", "block", "rate_limit"]),
          isDefault: rand() < 0.15,
          identities: Array.from(
            { length: Math.floor(rand() * 3) },
            randomIdentity,
          ),
          targets: Array.from(
            { length: 1 + Math.floor(rand() * 3) },
            randomTarget,
          ),
        }),
      );
      const legacy = legacyWalk(rows);
      const connections = grantedConnectionSelection(rows, AGENT, PRINCIPALS);
      const secrets = grantedSecretSelection(rows, AGENT, PRINCIPALS);
      expect(connections.ids).toEqual(legacy.connectionIds);
      expect(connections.providerLevels).toEqual(legacy.providerLevels);
      expect(new Set(secrets.ids)).toEqual(legacy.secretIds);
      expect(secrets.levels).toEqual(legacy.secretLevels);
    }
  });
});
