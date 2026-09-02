import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The memory tool arms of the platform-tool dispatch (step 8), mocked at the
 * service seam: what reaches the model — validation words, refusal words,
 * result shapes — and what gets audited under whom. The two-fact fence and
 * the DB laws live in cron.pg.test.ts / memory.pg.test.ts.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

const state = vi.hoisted(() => ({
  sandbox: {
    agent: {
      id: "ag-1",
      workspaceId: "p1",
      workspace: { organizationId: "org-1" },
    },
  } as {
    agent: {
      id: string;
      workspaceId: string;
      workspace: { organizationId: string };
    };
  } | null,
  conversation: { id: "conv-1" } as { id: string } | null,
  turn: { id: "t-1", userId: "user-9" } as {
    id: string;
    userId: string | null;
  } | null,
}));

const memoryService = vi.hoisted(() => ({
  upsertMemoryByKey: vi.fn(),
  listMemories: vi.fn(),
  searchMemoriesForWorkspace: vi.fn(),
  getMemoryByKey: vi.fn(),
  memoryPressure: vi.fn(),
}));

const audit = vi.hoisted(() => ({ recordAuditEvent: vi.fn() }));

const skillService = vi.hoisted(() => ({
  createSkill: vi.fn(),
  listSkillsReachingAgent: vi.fn(),
  updateAgentSkillByName: vi.fn(),
  deleteAgentSkillByName: vi.fn(),
}));

vi.mock("@onecli/db", () => ({
  Prisma: {},
  db: {
    sandbox: { findFirst: async () => state.sandbox },
    conversation: { findFirst: async () => state.conversation },
    turn: { findFirst: async () => state.turn },
    user: { findUnique: async () => ({ email: "asker@example.com" }) },
  },
}));

vi.mock("./agent-memory-service", () => ({
  upsertMemoryByKey: memoryService.upsertMemoryByKey,
  listMemories: memoryService.listMemories,
  searchMemoriesForWorkspace: memoryService.searchMemoriesForWorkspace,
  getMemoryByKey: memoryService.getMemoryByKey,
  memoryPressure: memoryService.memoryPressure,
  // Real co-importers still need these named exports to exist.
  createMemory: vi.fn(),
  updateMemory: vi.fn(),
  deleteMemory: vi.fn(),
  getMemory: vi.fn(),
  listRevisions: vi.fn(),
  restoreRevision: vi.fn(),
  redactRevision: vi.fn(),
  searchMemories: vi.fn(),
  MAX_MEMORIES_PER_AGENT: 100,
  MEMORY_REVISIONS_RETAINED: 50,
  MEMORY_SEARCH_LIMIT: 8,
  REDACTED_CONTENT: "[redacted]",
}));

vi.mock("./agent-cron-service", () => ({
  createCron: vi.fn(),
  deleteCron: vi.fn(),
  listCrons: vi.fn(),
  computeNextFire: vi.fn(),
  disableCron: vi.fn(),
  CRON_FAILURE_DISABLE_THRESHOLD: 5,
  MAX_CRONS_PER_AGENT: 20,
}));

vi.mock("./skill-service", () => ({
  createSkill: skillService.createSkill,
  listSkillsReachingAgent: skillService.listSkillsReachingAgent,
  updateAgentSkillByName: skillService.updateAgentSkillByName,
  deleteAgentSkillByName: skillService.deleteAgentSkillByName,
}));

vi.mock("./audit-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./audit-service")>()),
  recordAuditEvent: audit.recordAuditEvent,
}));

const { executePlatformTool, takeMemoryWriteToken, resetMemoryWritePacing } =
  await import("./platform-tool-service");
const { ServiceError } = await import("./errors");

const MEMORY = {
  id: "mem-1",
  agentId: "ag-1",
  key: "deploy-notes",
  title: null,
  description: null,
  content: "Deploys run from CI.",
  lastRevisionSeq: 2,
  createdAt: new Date("2026-08-07T00:00:00Z"),
  updatedAt: new Date("2026-08-07T00:00:00Z"),
};

const call = (tool: string, args: unknown, withTurn = true) =>
  executePlatformTool("r-1", {
    sandboxId: "sb-1",
    tool,
    args,
    ...(withTurn && { conversationId: "conv-1", turnId: "t-1" }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  state.sandbox = {
    agent: {
      id: "ag-1",
      workspaceId: "p1",
      workspace: { organizationId: "org-1" },
    },
  };
  state.conversation = { id: "conv-1" };
  state.turn = { id: "t-1", userId: "user-9" };
  memoryService.upsertMemoryByKey.mockResolvedValue({
    memory: MEMORY,
    created: false,
  });
  memoryService.listMemories.mockResolvedValue([MEMORY]);
  memoryService.memoryPressure.mockResolvedValue({ held: 1, max: 100 });
  memoryService.searchMemoriesForWorkspace.mockResolvedValue([
    { ...MEMORY, snippet: "Deploys run from **CI**.", rank: 0.5 },
  ]);
  memoryService.getMemoryByKey.mockResolvedValue(MEMORY);
});

describe("memory_save", () => {
  it("threads agent authorship with the resolved via-user and provenance", async () => {
    const response = await call("memory_save", {
      key: "deploy-notes",
      content: "Deploys run from CI.",
    });
    expect(response.ok).toBe(true);
    expect(memoryService.upsertMemoryByKey).toHaveBeenCalledWith(
      "p1",
      "ag-1",
      expect.objectContaining({ key: "deploy-notes" }),
      {
        authorKind: "agent",
        authorUserId: "user-9",
        // Denormalized at write time — attribution survives user deletion.
        authorEmail: "asker@example.com",
        conversationId: "conv-1",
        turnId: "t-1",
      },
    );
    expect(response.result).toEqual({
      key: "deploy-notes",
      created: false,
      revisionSeq: 2,
    });
  });

  it("audits an attributable save under the via-user; an update audits as update", async () => {
    await call("memory_save", { key: "deploy-notes", content: "x" });
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-9",
        userEmail: "asker@example.com",
        action: "update",
        service: "memory",
        metadata: expect.objectContaining({
          agentId: "ag-1",
          viaAgent: "true",
          key: "deploy-notes",
        }),
      }),
    );
  });

  it("a save from a turn with no user (a scheduled run) writes but audits nothing", async () => {
    state.turn = { id: "t-1", userId: null };
    const response = await call("memory_save", {
      key: "deploy-notes",
      content: "x",
    });
    expect(response.ok).toBe(true);
    expect(memoryService.upsertMemoryByKey).toHaveBeenCalledWith(
      "p1",
      "ag-1",
      expect.anything(),
      expect.objectContaining({ authorKind: "agent", authorUserId: null }),
    );
    expect(audit.recordAuditEvent).not.toHaveBeenCalled();
  });

  it("validation words reach the model verbatim", async () => {
    const response = await call("memory_save", {
      key: "Deploy Notes",
      content: "x",
    });
    expect(response.ok).toBe(false);
    expect(response.error).toContain("lowercase words separated");
  });

  it("a service refusal (the cap) reaches the model verbatim", async () => {
    memoryService.upsertMemoryByKey.mockRejectedValue(
      new ServiceError(
        "UNPROCESSABLE",
        "This agent already holds 100 memories. Update an existing key with memory_save, or delete one on the Memory page",
      ),
    );
    const response = await call("memory_save", { key: "k", content: "x" });
    expect(response.ok).toBe(false);
    expect(response.error).toContain("already holds 100 memories");
  });
});

describe("memory reads", () => {
  it("memory_list returns the body-free index with pressure counts and no audit", async () => {
    const response = await call("memory_list", {});
    expect(response.ok).toBe(true);
    expect(response.result).toEqual({
      memories: [
        { key: "deploy-notes", updatedAt: "2026-08-07T00:00:00.000Z" },
      ],
      held: 1,
      max: 100,
    });
    expect(audit.recordAuditEvent).not.toHaveBeenCalled();
  });

  it("memory_search returns snippets, never bodies", async () => {
    const response = await call("memory_search", { query: "deploys" });
    expect(response.ok).toBe(true);
    const result = response.result as { matches: Record<string, unknown>[] };
    expect(result.matches[0]).not.toHaveProperty("content");
    expect(result.matches[0]?.snippet).toContain("**CI**");
  });

  it("memory_get returns the full body; an unknown key's words pass through", async () => {
    const hit = await call("memory_get", { key: "deploy-notes" });
    expect(hit.ok).toBe(true);
    expect((hit.result as { content: string }).content).toBe(
      "Deploys run from CI.",
    );

    memoryService.getMemoryByKey.mockRejectedValue(
      new ServiceError(
        "NOT_FOUND",
        'No memory named "nope". memory_list shows what exists.',
      ),
    );
    const miss = await call("memory_get", { key: "nope" });
    expect(miss.ok).toBe(false);
    expect(miss.error).toBe(
      'No memory named "nope". memory_list shows what exists.',
    );
  });
});

describe("the skill tools", () => {
  const SKILL = {
    id: "sk-1",
    scope: "agent",
    agentId: "ag-1",
    workspaceId: null,
    organizationId: null,
    name: "release-checklist",
    description: "Use when cutting a release",
    content: "# Steps",
    enabled: true,
    createdByEmail: null,
    createdAt: new Date("2026-08-07T00:00:00Z"),
    updatedAt: new Date("2026-08-07T00:00:00Z"),
    files: [],
  };

  beforeEach(() => {
    skillService.createSkill.mockResolvedValue(SKILL);
    skillService.listSkillsReachingAgent.mockResolvedValue([
      { ...SKILL, fileCount: 0 },
      {
        ...SKILL,
        id: "sk-2",
        scope: "organization",
        agentId: null,
        organizationId: "org-1",
        name: "org-tone",
        fileCount: 1,
      },
    ]);
    skillService.updateAgentSkillByName.mockResolvedValue({
      skill: SKILL,
      noop: false,
    });
    skillService.deleteAgentSkillByName.mockResolvedValue({ id: "sk-1" });
  });

  it("skill_create lands on the AGENT tier with the via-user denormalized", async () => {
    const response = await call("skill_create", {
      name: "release-checklist",
      description: "Use when cutting a release",
      content: "# Steps",
    });
    expect(response.ok).toBe(true);
    expect(skillService.createSkill).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({
        agentId: "ag-1",
        name: "release-checklist",
      }),
      { userId: "user-9", email: "asker@example.com" },
    );
    expect(response.result).toEqual(
      expect.objectContaining({
        name: "release-checklist",
        scope: "agent",
        // Vendor-neutral: the control plane does not know the adapter's real
        // skills dir (the materializer re-roots the canonical path), so the
        // note must never hardcode one.
        note: expect.stringContaining("release-checklist/SKILL.md"),
      }),
    );
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-9",
        action: "create",
        service: "skill",
        metadata: expect.objectContaining({
          agentId: "ag-1",
          viaAgent: "true",
          name: "release-checklist",
        }),
      }),
    );
  });

  it("skill_create validation words reach the model verbatim", async () => {
    const response = await call("skill_create", {
      name: "Release Checklist",
      description: "d",
      content: "c",
    });
    expect(response.ok).toBe(false);
    expect(response.error).toContain("lowercase words separated");
    expect(skillService.createSkill).not.toHaveBeenCalled();
  });

  it("the reserved gateway name is refused with the belt's words", async () => {
    const response = await call("skill_create", {
      name: "onecli-gateway",
      description: "d",
      content: "c",
    });
    expect(response.ok).toBe(false);
    expect(response.error).toContain("reserved");
    expect(skillService.createSkill).not.toHaveBeenCalled();
  });

  it("skill_list marks only agent rows editable and teaches shadowing", async () => {
    const response = await call("skill_list", {});
    expect(response.ok).toBe(true);
    expect(skillService.listSkillsReachingAgent).toHaveBeenCalledWith(
      "ag-1",
      "p1",
      "org-1",
    );
    const result = response.result as {
      skills: { name: string; editable: boolean }[];
      note: string;
    };
    expect(result.skills).toEqual([
      expect.objectContaining({ name: "release-checklist", editable: true }),
      expect.objectContaining({ name: "org-tone", editable: false }),
    ]);
    expect(result.skills[0]).not.toHaveProperty("content");
    expect(result.note).toContain("most specific one wins");
    expect(audit.recordAuditEvent).not.toHaveBeenCalled();
  });

  it("skill_update requires an actual change and audits real ones", async () => {
    const nothing = await call("skill_update", { name: "release-checklist" });
    expect(nothing.ok).toBe(false);
    expect(nothing.error).toContain("Nothing to update");

    const response = await call("skill_update", {
      name: "release-checklist",
      enabled: false,
    });
    expect(response.ok).toBe(true);
    expect(skillService.updateAgentSkillByName).toHaveBeenCalledWith(
      "ag-1",
      "p1",
      "org-1",
      "release-checklist",
      { enabled: false },
    );
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "update",
        service: "skill",
        metadata: expect.objectContaining({ fields: "enabled" }),
      }),
    );
  });

  it("a no-op update audits nothing and says so", async () => {
    skillService.updateAgentSkillByName.mockResolvedValue({
      skill: SKILL,
      noop: true,
    });
    const response = await call("skill_update", {
      name: "release-checklist",
      content: "# Steps",
    });
    expect(response.ok).toBe(true);
    expect((response.result as { noop: boolean }).noop).toBe(true);
    expect(audit.recordAuditEvent).not.toHaveBeenCalled();
  });

  it("a broader-tier refusal reaches the model verbatim (the dashboard pointer)", async () => {
    skillService.updateAgentSkillByName.mockRejectedValue(
      new ServiceError(
        "FORBIDDEN",
        '"org-tone" is a organization skill, managed by the people you work with in the dashboard.',
      ),
    );
    const response = await call("skill_update", {
      name: "org-tone",
      enabled: false,
    });
    expect(response.ok).toBe(false);
    expect(response.error).toContain("managed by the people you work with");
  });

  it("skill_delete deletes by name and audits under the via-user", async () => {
    const response = await call("skill_delete", { name: "release-checklist" });
    expect(response.ok).toBe(true);
    expect(skillService.deleteAgentSkillByName).toHaveBeenCalledWith(
      "ag-1",
      "p1",
      "org-1",
      "release-checklist",
    );
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "delete",
        service: "skill",
        metadata: expect.objectContaining({
          skillId: "sk-1",
          name: "release-checklist",
        }),
      }),
    );
  });

  it("a skill write from a turn with no user writes but audits nothing", async () => {
    state.turn = { id: "t-1", userId: null };
    const response = await call("skill_create", {
      name: "release-checklist",
      description: "d",
      content: "c",
    });
    expect(response.ok).toBe(true);
    expect(skillService.createSkill).toHaveBeenCalledWith(
      "p1",
      expect.anything(),
      { userId: null, email: null },
    );
    expect(audit.recordAuditEvent).not.toHaveBeenCalled();
  });
});

describe("the fence", () => {
  it("stays hint-free when the sandbox is not this runner's", async () => {
    state.sandbox = null;
    const response = await call("memory_save", { key: "k", content: "x" });
    expect(response).toEqual({
      ok: false,
      error: "This tool is not available.",
    });
    expect(memoryService.upsertMemoryByKey).not.toHaveBeenCalled();
  });

  it("a forged conversation drops provenance, never the write", async () => {
    state.conversation = null;
    const response = await call("memory_save", { key: "k", content: "x" });
    expect(response.ok).toBe(true);
    expect(memoryService.upsertMemoryByKey).toHaveBeenCalledWith(
      "p1",
      "ag-1",
      expect.anything(),
      expect.objectContaining({
        authorUserId: null,
        conversationId: null,
        // The raw request's turn id must never survive an unverified
        // conversation — provenance is anchoring, verified or dropped.
        turnId: null,
      }),
    );
    expect(audit.recordAuditEvent).not.toHaveBeenCalled();
  });
});

describe("the memory-write token bucket", () => {
  beforeEach(() => resetMemoryWritePacing());

  it("a BACKWARDS clock step never spends tokens — no lockout", () => {
    // MUTATION-PROOF (lens-3 catch): drop the `Math.max(0, …)` elapsed floor
    // and a negative delta SUBTRACTS tokens with no lower clamp, locking the
    // sandbox out of memory writes for the length of the step. Wall-clock
    // steps back on NTP correction / VM resume.
    const t0 = 1_000_000_000_000;
    expect(takeMemoryWriteToken("sb", t0)).toBe(true);
    // One hour backwards.
    expect(takeMemoryWriteToken("sb", t0 - 3_600_000)).toBe(true);
    // And forward again — still serving, not locked out.
    expect(takeMemoryWriteToken("sb", t0)).toBe(true);
  });

  it("is per-sandbox — draining one never paces another", () => {
    const t0 = 1_000_000_000_000;
    for (let i = 0; i < 20; i += 1) {
      expect(takeMemoryWriteToken("a", t0)).toBe(true);
    }
    expect(takeMemoryWriteToken("a", t0)).toBe(false); // a is drained
    expect(takeMemoryWriteToken("b", t0)).toBe(true); // b untouched
  });
});
