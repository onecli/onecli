import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TOOL_RESULT_CHARS } from "@onecli/agent-protocol";

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
  conversation: {
    id: "conv-1",
    source: "web",
    direct: true,
    userId: "user-9",
    externalRef: null,
  } as {
    id: string;
    source: string;
    direct: boolean;
    userId: string | null;
    externalRef: string | null;
  } | null,
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

const connectionsRender = vi.hoisted(() => ({
  connectionsForRender: vi.fn(),
  customConnectionsForRender: vi.fn(),
}));

const agentDesktop = vi.hoisted(() => ({ callTool: vi.fn() }));

const skillService = vi.hoisted(() => ({
  createSkill: vi.fn(),
  listSkillsReachingAgent: vi.fn(),
  updateAgentSkillByName: vi.fn(),
  deleteAgentSkillByName: vi.fn(),
}));

const webhookService = vi.hoisted(() => ({
  listWebhooks: vi.fn(),
  listWebhookRuns: vi.fn(),
  requestWebhookUpdate: vi.fn(),
}));

const access = vi.hoisted(() => ({ canAccessWorkspaceAsUser: vi.fn() }));

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

// The GitHub library: no library skills unless a
// test plants one, so the skill_* paths behave as before.
const library = vi.hoisted(() => ({
  names: [] as { name: string; description: string; repo: string }[],
}));
vi.mock("./skill-library-service", () => ({
  libraryNamesForAgent: async () => library.names,
}));

vi.mock("./agent-connections-render", () => ({
  connectionsForRender: connectionsRender.connectionsForRender,
  customConnectionsForRender: connectionsRender.customConnectionsForRender,
}));

const approvals = vi.hoisted(() => ({ requestActionApproval: vi.fn() }));

vi.mock("./channels/action-approval-service", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./channels/action-approval-service")
  >()),
  requestActionApproval: approvals.requestActionApproval,
}));

vi.mock("./agent-webhook-service", () => webhookService);

vi.mock("./workspace-access-check", () => access);

vi.mock("./audit-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./audit-service")>()),
  recordAuditEvent: audit.recordAuditEvent,
}));

const { executePlatformTool, takeMemoryWriteToken, resetMemoryWritePacing } =
  await import("./platform-tool-service");
const { ServiceError } = await import("./errors");
const { initAgentDesktop } = await import("../providers/hooks/agent-desktop");

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
  state.conversation = {
    id: "conv-1",
    source: "web",
    direct: true,
    userId: "user-9",
    externalRef: null,
  };
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
  access.canAccessWorkspaceAsUser.mockResolvedValue(true);
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
    expect(result.note).toContain("yours wins");
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

  it("an org-tier refusal reaches the model verbatim (the dashboard pointer)", async () => {
    skillService.updateAgentSkillByName.mockRejectedValue(
      new ServiceError(
        "FORBIDDEN",
        '"org-tone" is an organization skill, managed by the people you work with in the dashboard.',
      ),
    );
    const response = await call("skill_update", {
      name: "org-tone",
      enabled: false,
    });
    expect(response.ok).toBe(false);
    expect(response.error).toContain("managed by the people you work with");
  });

  it("a library skill (from the org's Git repo) is listed read-only and never written", async () => {
    library.names = [
      { name: "snowflake", description: "Query it", repo: "acme/skills" },
    ];
    try {
      const listed = await call("skill_list", {});
      expect(
        (
          listed.result as {
            skills: { name: string; scope: string; editable: boolean }[];
          }
        ).skills,
      ).toContainEqual(
        expect.objectContaining({
          name: "snowflake",
          scope: "library",
          editable: false,
        }),
      );
      for (const [tool, args] of [
        ["skill_update", { name: "snowflake", enabled: false }],
        ["skill_delete", { name: "snowflake" }],
        ["skill_create", { name: "snowflake", description: "d", content: "c" }],
      ] as const) {
        const res = await call(tool, args);
        expect(res.ok, tool).toBe(false);
        expect(res.error).toContain("managed in that Git repo");
      }
      expect(skillService.updateAgentSkillByName).not.toHaveBeenCalled();
      expect(skillService.deleteAgentSkillByName).not.toHaveBeenCalled();
      expect(skillService.createSkill).not.toHaveBeenCalled();
    } finally {
      library.names = [];
    }
  });

  it("skill_delete deletes by name and audits under the via-user", async () => {
    const response = await call("skill_delete", { name: "release-checklist" });
    expect(response.ok).toBe(true);
    expect(skillService.deleteAgentSkillByName).toHaveBeenCalledWith(
      "ag-1",
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

describe("list_apps", () => {
  const granola = {
    provider: "granola",
    name: "Granola",
    label: "API Key",
    host: null,
    apiHosts: ["public-api.granola.ai"],
    endpoints: ["GET /v1/notes"],
    docsUrl: "https://docs.granola.ai/introduction",
  };

  beforeEach(() => {
    connectionsRender.customConnectionsForRender.mockResolvedValue([]);
  });

  it("lists custom connections in their own section, with the pin hint", async () => {
    connectionsRender.connectionsForRender.mockResolvedValue([]);
    const custom = {
      id: "sec-1",
      name: "Prod key",
      host: "api.example.com",
      path: "/v2/*",
    };
    connectionsRender.customConnectionsForRender.mockResolvedValue([custom]);
    const res = await call("list_apps", {});
    expect(connectionsRender.customConnectionsForRender).toHaveBeenCalledWith(
      "ag-1",
    );
    expect(res).toMatchObject({
      ok: true,
      result: { apps: [], customConnections: [custom] },
    });
    expect(JSON.stringify(res)).toContain("x-onecli-connection-id");
  });

  it("omits the custom section when there is none", async () => {
    connectionsRender.connectionsForRender.mockResolvedValue([granola]);
    const res = await call("list_apps", {});
    expect(res.ok && "customConnections" in (res.result as object)).toBe(false);
  });

  it("answers from the composer for the CALLING agent only", async () => {
    connectionsRender.connectionsForRender.mockResolvedValue([granola]);
    const res = await call("list_apps", {});
    expect(connectionsRender.connectionsForRender).toHaveBeenCalledWith("ag-1");
    expect(res).toMatchObject({ ok: true, result: { apps: [granola] } });
  });

  it("an empty grant set says so, and where it is changed", async () => {
    connectionsRender.connectionsForRender.mockResolvedValue([]);
    const res = await call("list_apps", {});
    expect(res).toMatchObject({ ok: true, result: { apps: [] } });
    expect(JSON.stringify(res)).toContain("OneCLI dashboard");
  });

  it("a sandbox this runner does not host learns nothing", async () => {
    state.sandbox = null;
    const res = await call("list_apps", {});
    expect(res.ok).toBe(false);
    expect(connectionsRender.connectionsForRender).not.toHaveBeenCalled();
  });
});

describe("request_human_takeover", () => {
  // The tool is a hosted-platform one: the shared dispatcher only routes it
  // through the agent-desktop seam, with the asking turn as provenance.
  // Its own validation and words are pinned beside the implementation
  // (ee/desktop/index.test.ts).
  afterEach(() => initAgentDesktop(null));

  it("routes the call through the seam for the CALLING agent, with the asking turn as provenance", async () => {
    agentDesktop.callTool.mockResolvedValue({
      ok: true,
      result: { status: "requested" },
    });
    initAgentDesktop({
      sweep: vi.fn(),
      claimPushes: vi.fn(),
      markActivity: vi.fn(),
      mintTicket: vi.fn(),
      callTool: agentDesktop.callTool,
    });
    const res = await call("request_human_takeover", {
      reason: "Sign in to the portal",
    });
    expect(agentDesktop.callTool).toHaveBeenCalledWith({
      agentId: "ag-1",
      args: { reason: "Sign in to the portal" },
      originConversationId: "conv-1",
      originTurnId: "t-1",
    });
    expect(res).toEqual({ ok: true, result: { status: "requested" } });
  });

  it("is refused where the deployment has no hosted desktop (every self-host)", async () => {
    initAgentDesktop(null);
    const res = await call("request_human_takeover", { reason: "captcha" });
    expect(res).toEqual({ ok: false, error: "This tool is not available." });
    expect(agentDesktop.callTool).not.toHaveBeenCalled();
  });
});

describe("propose_custom_connection", () => {
  const proposal = {
    name: "AcmeCRM",
    hostPattern: "api.acmecrm.io",
    headerName: "X-Api-Key",
    valueFormat: "{value}",
    docsUrl: "https://docs.acmecrm.io/auth",
    reason: "You asked for your AcmeCRM campaigns.",
  };

  beforeEach(() => {
    approvals.requestActionApproval.mockResolvedValue({
      id: "aa-1",
      status: "pending",
    });
  });

  it("holds a valid proposal for the CALLING agent, anchored on the turn", async () => {
    const res = await call("propose_custom_connection", proposal);
    expect(approvals.requestActionApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "ag-1",
        action: "secret.create_custom",
        payload: proposal,
      }),
    );
    expect(res).toMatchObject({
      ok: true,
      result: { status: "held", approvalId: "aa-1", host: "api.acmecrm.io" },
    });
    expect(JSON.stringify(res)).toContain("Never ask them to paste the key");
  });

  it("refuses a value argument outright: nothing is held", async () => {
    const res = await call("propose_custom_connection", {
      ...proposal,
      value: "sk-live-secret",
    });
    expect(res.ok).toBe(false);
    expect(approvals.requestActionApproval).not.toHaveBeenCalled();
    expect(JSON.stringify(res)).not.toContain("sk-live-secret");
  });

  it("refuses a catalog app's host and points at the real app", async () => {
    const res = await call("propose_custom_connection", {
      ...proposal,
      hostPattern: "api.github.com",
    });
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).toContain("built-in OneCLI app");
    expect(approvals.requestActionApproval).not.toHaveBeenCalled();
  });

  it("refuses a private host", async () => {
    const res = await call("propose_custom_connection", {
      ...proposal,
      hostPattern: "169.254.169.254",
    });
    expect(res.ok).toBe(false);
    expect(approvals.requestActionApproval).not.toHaveBeenCalled();
  });
});

describe("the webhook tools", () => {
  const HOOK = {
    id: "wh-1",
    agentId: "ag-1",
    name: "Meeting notes",
    instructions: "Save the notes to Drive.",
    url: "https://api.example.test/v1/hooks/whk_secret",
    enabled: true,
    disabledReason: null,
    lastReceivedAt: new Date("2026-10-13T14:10:00Z"),
    lastOutcome: "ok",
    createdAt: new Date("2026-10-01T00:00:00Z"),
  };
  const run = (event: string) => ({
    turnId: "t-run",
    status: "done",
    receivedAt: "2026-10-13T14:10:00.000Z",
    finishedAt: "2026-10-13T14:11:00.000Z",
    instructions: "Save the notes to Drive.",
    event,
    report: "Saved.",
    error: null,
  });
  /** Every arm, so each refusal is proven for reads and the write alike. */
  const ARMS = [
    ["list_webhooks", {}],
    ["webhook_runs", { webhookId: "wh-1" }],
    ["update_webhook", { webhookId: "wh-1", enabled: false }],
  ] as const;
  const untouched = () => {
    expect(webhookService.listWebhooks).not.toHaveBeenCalled();
    expect(webhookService.listWebhookRuns).not.toHaveBeenCalled();
    expect(webhookService.requestWebhookUpdate).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    webhookService.listWebhooks.mockResolvedValue([HOOK]);
    webhookService.listWebhookRuns.mockResolvedValue([]);
    webhookService.requestWebhookUpdate.mockResolvedValue({
      kind: "held",
      approvalId: "act-1",
      name: "Meeting notes",
    });
  });

  it("list_webhooks never hands the agent a URL or token, only the dashboard page", async () => {
    const response = await call("list_webhooks", {});
    expect(response.ok).toBe(true);
    const text = JSON.stringify(response.result);
    expect(text).not.toContain("whk_");
    expect(text).not.toContain("/v1/hooks/");
    expect(response.result).toMatchObject({
      manageUrl: expect.stringMatching(
        /^https?:\/\/[^/]+\/w\/p1\/agents\/ag-1\/webhooks$/,
      ),
      webhooks: [
        {
          webhookId: "wh-1",
          name: "Meeting notes",
          instructions: "Save the notes to Drive.",
          enabled: true,
          lastOutcome: "ok",
        },
      ],
    });
    expect(webhookService.listWebhooks).toHaveBeenCalledWith("p1", "ag-1");
  });

  it("webhook_runs is fenced to the calling agent and defaults to 5", async () => {
    await call("webhook_runs", { webhookId: "wh-1" });
    expect(webhookService.listWebhookRuns).toHaveBeenCalledWith(
      "p1",
      "ag-1",
      "wh-1",
      5,
    );
  });

  it("webhook_runs bounds the page it asks for", async () => {
    const response = await call("webhook_runs", {
      webhookId: "wh-1",
      limit: 500,
    });
    expect(response.ok).toBe(false);
    untouched();
  });

  it("webhook_runs drops the oldest runs until an escape-heavy page fits the result cap", async () => {
    // 1,000 quotes serialize to 2,000 chars, and a control character to 6:
    // ten such runs would be over 64k, so a URL holder could otherwise make
    // the history unreadable.
    const hostile = `${'"'.repeat(500)}${"\u0001".repeat(500)}`;
    webhookService.listWebhookRuns.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({
        ...run(hostile),
        turnId: `t-${i}`,
        report: hostile,
        instructions: hostile,
      })),
    );
    const response = await call("webhook_runs", {
      webhookId: "wh-1",
      limit: 10,
    });
    expect(response.ok).toBe(true);
    const result = response.result as { runs: { turnId: string }[] };
    expect(JSON.stringify(result).length).toBeLessThan(MAX_TOOL_RESULT_CHARS);
    expect(result.runs.length).toBeGreaterThan(0);
    expect(result.runs.length).toBeLessThan(10);
    // Newest first, so the newest survive.
    expect(result.runs[0]?.turnId).toBe("t-0");
    expect(response.result).toHaveProperty("omitted");
  });

  it("update_webhook from the owner's private chat holds the change for approval, writing nothing", async () => {
    const response = await call("update_webhook", {
      webhookId: "wh-1",
      instructions: "Save to the Meetings folder.",
    });
    expect(response).toMatchObject({
      ok: true,
      result: { status: "held", approvalId: "act-1", name: "Meeting notes" },
    });
    expect(webhookService.requestWebhookUpdate).toHaveBeenCalledWith({
      workspaceId: "p1",
      agentId: "ag-1",
      conversationId: "conv-1",
      originTurnId: "t-1",
      change: {
        webhookId: "wh-1",
        instructions: "Save to the Meetings folder.",
      },
    });
    // The agent's ask audits nothing: the person's approval is the write.
    expect(audit.recordAuditEvent).not.toHaveBeenCalled();
  });

  it("update_webhook with a change already waiting says it was dropped, not queued", async () => {
    webhookService.requestWebhookUpdate.mockResolvedValue({
      kind: "busy",
      approvalId: "act-0",
      name: "Meeting notes",
    });
    const response = await call("update_webhook", {
      webhookId: "wh-1",
      enabled: false,
    });
    expect(response).toMatchObject({
      ok: true,
      result: { status: "not_changed", approvalId: "act-0" },
    });
  });

  it.each(ARMS)(
    "%s refuses a shared conversation, even when a member typed the turn",
    async (tool, args) => {
      // A channel thread: a guest's message there steers into this run.
      state.conversation = {
        id: "conv-1",
        source: "slack",
        direct: false,
        userId: null,
        externalRef: "C1:1.2",
      };
      const response = await call(tool, args);
      expect(response.ok).toBe(false);
      expect(response.error).toMatch(/own private chat/);
      untouched();
    },
  );

  it.each(ARMS)("%s refuses an automated run", async (tool, args) => {
    state.conversation = {
      id: "conv-1",
      source: "webhook",
      direct: false,
      userId: null,
      externalRef: "wh-1",
    };
    state.turn = { id: "t-1", userId: null };
    expect((await call(tool, args)).ok).toBe(false);
    untouched();
  });

  it.each(ARMS)(
    "%s refuses a turn in a private thread that its owner did not type",
    async (tool, args) => {
      state.turn = { id: "t-1", userId: null };
      expect((await call(tool, args)).ok).toBe(false);
      untouched();
    },
  );

  it.each(ARMS)("%s refuses with no calling context", async (tool, args) => {
    expect((await call(tool, args, false)).ok).toBe(false);
    untouched();
  });

  it.each(ARMS)(
    "%s refuses an owner who lost workspace access",
    async (tool, args) => {
      access.canAccessWorkspaceAsUser.mockResolvedValue(false);
      expect((await call(tool, args)).ok).toBe(false);
      untouched();
    },
  );

  it("update_webhook needs an actual change", async () => {
    const response = await call("update_webhook", { webhookId: "wh-1" });
    expect(response).toEqual({
      ok: false,
      error: "Nothing to update: pass name, instructions, or enabled",
    });
  });

  it("a foreign webhook id reads as not found", async () => {
    webhookService.requestWebhookUpdate.mockRejectedValue(
      new ServiceError("NOT_FOUND", "Webhook not found"),
    );
    const response = await call("update_webhook", {
      webhookId: "other",
      enabled: true,
    });
    expect(response).toEqual({ ok: false, error: "Webhook not found" });
  });
});
