import { beforeEach, describe, expect, it, vi } from "vitest";

import { LLM_HOST_FRAGMENTS } from "../lib/llm-hosts";
import { initRoleResolver } from "../providers";
import {
  buildActivityWhere,
  getRequestLogById,
  getRequestLogs,
} from "./request-log-service";

const dbState = vi.hoisted(() => ({
  logs: [] as unknown[],
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    requestLog: {
      findMany: async () => dbState.logs,
      // Honors BOTH halves of the where — the project scope is what makes a
      // foreign id indistinguishable from a missing one.
      findFirst: async ({
        where,
      }: {
        where: { id: string; projectId: string };
      }) =>
        (dbState.logs as { id: string; projectId: string }[]).find(
          (l) => l.id === where.id && l.projectId === where.projectId,
        ) ?? null,
    },
    agent: { findMany: async () => [] },
    user: { findMany: async () => [] },
  },
}));

const PROJECT_ID = "proj_activity_test";

describe("buildActivityWhere", () => {
  it("scopes to the project when given no filter or cursor", () => {
    expect(buildActivityWhere(PROJECT_ID)).toEqual({ projectId: PROJECT_ID });
  });

  it('applies no extra constraints for the "all" filter', () => {
    expect(buildActivityWhere(PROJECT_ID, { filter: "all" })).toEqual({
      projectId: PROJECT_ID,
    });
  });

  it('filters to status >= 400 for the "blocked" filter', () => {
    expect(buildActivityWhere(PROJECT_ID, { filter: "blocked" })).toEqual({
      projectId: PROJECT_ID,
      status: { gte: 400 },
    });
  });

  it('excludes every known AI host, case-insensitively, for "hide-llm"', () => {
    expect(buildActivityWhere(PROJECT_ID, { filter: "hide-llm" })).toEqual({
      projectId: PROJECT_ID,
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
    const where = buildActivityWhere(PROJECT_ID, {
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

// ── ActivityQuery narrowing (the #411 automation filters) ────────────────

describe("buildActivityWhere — ActivityQuery", () => {
  it("adds nothing when the query is empty", () => {
    expect(buildActivityWhere(PROJECT_ID, { query: {} })).toEqual({
      projectId: PROJECT_ID,
    });
  });

  it("matches agent exactly and host/provider case-insensitively", () => {
    const where = buildActivityWhere(PROJECT_ID, {
      query: { agentId: "agent-1", host: "GitHub.com", provider: "github" },
    });

    expect(where.AND).toEqual([
      { agentId: "agent-1" },
      { host: { contains: "GitHub.com", mode: "insensitive" } },
      { provider: { contains: "github", mode: "insensitive" } },
    ]);
  });

  it("upper-cases the method so ?method=get matches the stored verb", () => {
    expect(
      buildActivityWhere(PROJECT_ID, { query: { method: "get" } }).AND,
    ).toEqual([{ method: "GET" }]);
  });

  it("bounds the window with gte/lt so `since` is inclusive and `until` is not", () => {
    const since = new Date("2026-07-01T00:00:00.000Z");
    const until = new Date("2026-07-02T00:00:00.000Z");

    expect(
      buildActivityWhere(PROJECT_ID, { query: { since, until } }).AND,
    ).toEqual([{ createdAt: { gte: since } }, { createdAt: { lt: until } }]);
  });

  it("keeps status 0 and 200 distinct from `undefined` (no silent drop)", () => {
    expect(
      buildActivityWhere(PROJECT_ID, { query: { status: 200 } }).AND,
    ).toEqual([{ status: 200 }]);
    expect(buildActivityWhere(PROJECT_ID, { query: {} }).AND).toBeUndefined();
  });

  // The reason query conditions are ANDed rather than assigned onto the root:
  // `filter: "blocked"` owns `status` and the cursor owns `OR`. A root
  // assignment would drop one of them — here it would turn a contradictory
  // "blocked AND status=200" into "every 200", the opposite of what was asked.
  it("preserves the blocked filter's own status clause alongside a status query", () => {
    const where = buildActivityWhere(PROJECT_ID, {
      filter: "blocked",
      query: { status: 200 },
    });

    expect(where.status).toEqual({ gte: 400 });
    expect(where.AND).toEqual([{ status: 200 }]);
  });

  it("preserves the cursor's OR alongside query conditions", () => {
    const cursor = { createdAt: "2026-06-26T12:00:00.000Z", id: "log_42" };
    const where = buildActivityWhere(PROJECT_ID, {
      cursor,
      query: { agentId: "agent-1" },
    });

    expect(where.OR).toHaveLength(2);
    expect(where.AND).toEqual([{ agentId: "agent-1" }]);
  });
});

// ── Org matched-rule redaction (admin-only visibility, applied to reads) ──

const ORG_BAIT = "ORG-RULE-NAME-BAIT";

const logRow = (over: Record<string, unknown>) => ({
  id: "log-1",
  projectId: PROJECT_ID,
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

const projectDecidedRow = () =>
  logRow({
    id: "log-2",
    extraData: {
      matched_rule_name: "Project rule",
      matched_rule_scope: "project",
    },
    matchedRuleLogicalId: "p-l1",
  });

describe("getRequestLogs — org matched-rule redaction", () => {
  beforeEach(() => {
    dbState.logs = [orgDecidedRow(), projectDecidedRow()];
  });

  it("REDACTS the org rule's name + logical id for a non-admin viewer", async () => {
    initRoleResolver({ getUserRole: async () => "member" });

    const page = await getRequestLogs(
      PROJECT_ID,
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
    // project-scoped attribution stays fully visible.
    const [orgLog, projectLog] = page.logs;
    expect(orgLog?.matchedRuleLogicalId).toBeNull();
    expect(
      (orgLog?.extraData as Record<string, unknown>).matched_rule_scope,
    ).toBe("organization");
    expect(projectLog?.matchedRuleLogicalId).toBe("p-l1");
    expect(
      (projectLog?.extraData as Record<string, unknown>).matched_rule_name,
    ).toBe("Project rule");
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
      // rules are project-level.
      logRow({
        id: "log-3",
        status: 403,
        extraData: { decision: "blocked", blocked_by_rule: "Legacy block" },
      }),
    ];

    const page = await getRequestLogs(
      PROJECT_ID,
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
      PROJECT_ID,
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

    const noViewer = await getRequestLogs(PROJECT_ID, {});
    expect(JSON.stringify(noViewer)).not.toContain(ORG_BAIT);

    const nullRole = await getRequestLogs(
      PROJECT_ID,
      {},
      {
        userId: "u1",
        organizationId: "org-1",
      },
    );
    expect(JSON.stringify(nullRole)).not.toContain(ORG_BAIT);
  });
});

// ── getRequestLogById (the #411 single-event read) ───────────────────────

describe("getRequestLogById", () => {
  beforeEach(() => {
    dbState.logs = [orgDecidedRow(), projectDecidedRow()];
  });

  it("returns the event when it belongs to the project", async () => {
    initRoleResolver({ getUserRole: async () => "admin" });

    const entry = await getRequestLogById(PROJECT_ID, "log-2", {
      userId: "u1",
      organizationId: "org-1",
    });

    expect(entry?.id).toBe("log-2");
    expect(entry?.host).toBe("gmail.googleapis.com");
  });

  it("returns null for another project's id — never leaks across the fence", async () => {
    initRoleResolver({ getUserRole: async () => "admin" });

    // The row exists; it just isn't this project's. Indistinguishable from
    // "no such id", which is what stops id probing.
    const entry = await getRequestLogById("someone-elses-project", "log-2", {
      userId: "u1",
      organizationId: "org-1",
    });

    expect(entry).toBeNull();
  });

  it("returns null for an unknown id", async () => {
    expect(await getRequestLogById(PROJECT_ID, "nope")).toBeNull();
  });

  // The reason this goes through the shared redaction rather than returning
  // the row: a single-row read must not become the way to see what the feed
  // hides from a non-admin.
  it("applies the SAME org-rule redaction as the feed", async () => {
    initRoleResolver({ getUserRole: async () => "member" });

    const entry = await getRequestLogById(PROJECT_ID, "log-1", {
      userId: "u1",
      organizationId: "org-1",
    });

    expect(JSON.stringify(entry)).not.toContain(ORG_BAIT);
    expect(entry?.matchedRuleLogicalId).toBeNull();
    expect(
      (entry?.extraData as Record<string, unknown>).matched_rule_scope,
    ).toBe("organization");
  });

  it("fails SAFE to redaction when there is no viewer", async () => {
    initRoleResolver({ getUserRole: async () => "admin" });

    const entry = await getRequestLogById(PROJECT_ID, "log-1");

    expect(JSON.stringify(entry)).not.toContain(ORG_BAIT);
  });
});
