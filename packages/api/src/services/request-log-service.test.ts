import { beforeEach, describe, expect, it, vi } from "vitest";

import { LLM_HOST_FRAGMENTS } from "../lib/llm-hosts";
import { initRoleResolver } from "../providers";
import {
  buildActivityWhere,
  getMatchedRuleScope,
  getRequestLogs,
} from "./request-log-service";

const dbState = vi.hoisted(() => ({
  logs: [] as unknown[],
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    requestLog: { findMany: async () => dbState.logs },
    agent: { findMany: async () => [] },
    user: { findMany: async () => [] },
  },
}));

const WORKSPACE_ID = "ws_activity_test";

describe("getMatchedRuleScope", () => {
  const withScope = (scope: unknown) =>
    ({ extraData: { matched_rule_scope: scope } }) as never;

  it("normalizes the pre-rename 'project' value to 'workspace'", () => {
    // MUTATION-PROOF: this is the whole reason the rename migration is allowed
    // to skip backfilling request_logs.extra_data (the highest-volume table).
    expect(getMatchedRuleScope(withScope("project"))).toBe("workspace");
  });

  it("passes current values through untouched", () => {
    expect(getMatchedRuleScope(withScope("workspace"))).toBe("workspace");
    expect(getMatchedRuleScope(withScope("organization"))).toBe("organization");
  });

  it("is null when the row records no scope at all (legacy rows)", () => {
    expect(getMatchedRuleScope(withScope(undefined))).toBeNull();
    expect(getMatchedRuleScope({ extraData: null } as never)).toBeNull();
  });
});

describe("buildActivityWhere", () => {
  it("scopes to the workspace when given no filter or cursor", () => {
    expect(buildActivityWhere(WORKSPACE_ID)).toEqual({
      workspaceId: WORKSPACE_ID,
    });
  });

  it('applies no extra constraints for the "all" filter', () => {
    expect(buildActivityWhere(WORKSPACE_ID, { filter: "all" })).toEqual({
      workspaceId: WORKSPACE_ID,
    });
  });

  it('filters to status >= 400 for the "blocked" filter', () => {
    expect(buildActivityWhere(WORKSPACE_ID, { filter: "blocked" })).toEqual({
      workspaceId: WORKSPACE_ID,
      status: { gte: 400 },
    });
  });

  it('excludes every known AI host, case-insensitively, for "hide-llm"', () => {
    expect(buildActivityWhere(WORKSPACE_ID, { filter: "hide-llm" })).toEqual({
      workspaceId: WORKSPACE_ID,
      NOT: {
        OR: LLM_HOST_FRAGMENTS.map((fragment) => ({
          host: { contains: fragment, mode: "insensitive" },
        })),
      },
    });
  });

  it("classifies anthropic.com as AI but leaves non-AI hosts like github.com", () => {
    const fragments: readonly string[] = LLM_HOST_FRAGMENTS;
    expect(fragments).toContain("anthropic.com");
    expect(fragments).not.toContain("github.com");
  });

  it('keeps the keyset cursor clauses alongside the "hide-llm" exclusion', () => {
    const cursor = { createdAt: "2026-06-26T12:00:00.000Z", id: "log_42" };
    const where = buildActivityWhere(WORKSPACE_ID, {
      filter: "hide-llm",
      cursor,
    });

    expect(where.NOT).toBeDefined();
    expect(where.OR).toEqual([
      { createdAt: { lt: new Date(cursor.createdAt) } },
      { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
    ]);
  });
});

// ── Org matched-rule redaction (admin-only visibility, applied to reads) ──

const ORG_BAIT = "ORG-RULE-NAME-BAIT";

const logRow = (over: Record<string, unknown>) => ({
  id: "log-1",
  workspaceId: WORKSPACE_ID,
  agentId: "agent-1",
  method: "GET",
  host: "gmail.googleapis.com",
  path: "/v1",
  provider: "gmail",
  status: 200,
  latencyMs: 10,
  injectionCount: 1,
  extraData: null,
  matchedRuleLogicalId: null,
  createdAt: new Date("2026-07-18T00:00:00Z"),
  ...over,
});

const orgDecidedRow = () =>
  logRow({
    extraData: {
      matched_rule_name: ORG_BAIT,
      matched_rule_scope: "organization",
    },
    matchedRuleLogicalId: "org-l1",
  });

const workspaceDecidedRow = () =>
  logRow({
    id: "log-2",
    extraData: {
      matched_rule_name: "Workspace rule",
      matched_rule_scope: "workspace",
    },
    matchedRuleLogicalId: "p-l1",
  });

describe("getRequestLogs — org matched-rule redaction", () => {
  beforeEach(() => {
    dbState.logs = [orgDecidedRow(), workspaceDecidedRow()];
  });

  it("REDACTS the org rule's name + logical id for a non-admin viewer", async () => {
    initRoleResolver({ getUserRole: async () => "member" });

    const page = await getRequestLogs(
      WORKSPACE_ID,
      {},
      {
        userId: "u1",
        organizationId: "org-1",
      },
    );

    // The load-bearing assertion: the serialized payload the client receives
    // (incl. the raw extra_data dump) carries NO org rule identifiers…
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain(ORG_BAIT);
    expect(serialized).not.toContain("org-l1");
    // …but keeps the scope so the UI can say "an organization rule", and the
    // workspace-scoped attribution stays fully visible.
    const [orgLog, workspaceLog] = page.logs;
    expect(orgLog?.matchedRuleLogicalId).toBeNull();
    expect(
      (orgLog?.extraData as Record<string, unknown>).matched_rule_scope,
    ).toBe("organization");
    expect(workspaceLog?.matchedRuleLogicalId).toBe("p-l1");
    expect(
      (workspaceLog?.extraData as Record<string, unknown>).matched_rule_name,
    ).toBe("Workspace rule");
  });

  it("scrubs blocked_by_rule too when an ORG rule blocked (v2 carries the same name there)", async () => {
    initRoleResolver({ getUserRole: async () => "member" });
    dbState.logs = [
      logRow({
        status: 403,
        extraData: {
          decision: "blocked",
          blocked_by_rule: ORG_BAIT,
          matched_rule_name: ORG_BAIT,
          matched_rule_scope: "organization",
        },
        matchedRuleLogicalId: "org-l1",
      }),
      // A LEGACY block (no matched_rule_scope) keeps its name — old-model
      // rules are workspace-level.
      logRow({
        id: "log-3",
        status: 403,
        extraData: { decision: "blocked", blocked_by_rule: "Legacy block" },
      }),
    ];

    const page = await getRequestLogs(
      WORKSPACE_ID,
      {},
      {
        userId: "u1",
        organizationId: "org-1",
      },
    );

    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain(ORG_BAIT);
    expect(serialized).toContain("Legacy block");
    // The verdict itself stays visible — only the org rule's identity is gone.
    expect((page.logs[0]?.extraData as Record<string, unknown>).decision).toBe(
      "blocked",
    );
  });

  it("shows the full org rule to org admins", async () => {
    initRoleResolver({ getUserRole: async () => "admin" });

    const page = await getRequestLogs(
      WORKSPACE_ID,
      {},
      {
        userId: "u1",
        organizationId: "org-1",
      },
    );

    expect(JSON.stringify(page)).toContain(ORG_BAIT);
    expect(page.logs[0]?.matchedRuleLogicalId).toBe("org-l1");
  });

  it("fails SAFE to redaction with no viewer or a null role", async () => {
    initRoleResolver({ getUserRole: async () => null });

    const noViewer = await getRequestLogs(WORKSPACE_ID, {});
    expect(JSON.stringify(noViewer)).not.toContain(ORG_BAIT);

    const nullRole = await getRequestLogs(
      WORKSPACE_ID,
      {},
      {
        userId: "u1",
        organizationId: "org-1",
      },
    );
    expect(JSON.stringify(nullRole)).not.toContain(ORG_BAIT);
  });
});
