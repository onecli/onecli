import { db } from "@onecli/db";
import {
  MAX_TOOL_RESULT_CHARS,
  type RunnerMemoryWriteRequest,
  type RunnerMemoryWriteResponse,
  type RunnerToolCallRequest,
  type RunnerToolCallResponse,
} from "@onecli/agent-protocol";
import { ServiceError } from "./errors";
import {
  createCron,
  deleteCron,
  listCrons,
  nextFireOrNull,
} from "./agent-cron-service";
import {
  getMemoryByKey,
  listMemories,
  memoryPressure,
  saveMemoryFromFile,
  searchMemoriesForWorkspace,
  upsertMemoryByKey,
  type AgentMemoryView,
  type MemoryAuthor,
} from "./agent-memory-service";
import {
  cancelTaskArgsSchema,
  scheduleTaskArgsSchema,
} from "../validations/crons";
import { AUTOMATION_SOURCES } from "../validations/conversation";
import {
  memoryGetArgsSchema,
  memoryListArgsSchema,
  memorySaveArgsSchema,
  memorySearchArgsSchema,
} from "../validations/memories";
import {
  skillCreateArgsSchema,
  skillDeleteArgsSchema,
  skillListArgsSchema,
  skillUpdateArgsSchema,
} from "../validations/skills";
import {
  createSkill,
  deleteAgentSkillByName,
  listSkillsReachingAgent,
  updateAgentSkillByName,
} from "./skill-service";
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
  AUDIT_SOURCE,
  recordAuditEvent,
} from "./audit-service";
import { logger } from "../lib/logger";

const log = logger.child({ component: "platform-tools" });

/**
 * The control-plane end of the platform-tool channel (step 7, §3.7).
 *
 * THE FENCE IS THE WHOLE STORY. A tool call arrives with two authenticated
 * facts — the runner (its `rnr_` token) and the sandbox (the ws channel the
 * runner stamped) — and the agent's identity is DERIVED from them, never
 * presented: the sandbox row is resolved under both, and `Sandbox.agentId`
 * is unique, so "the agent that owns this sandbox" is exact. This is the
 * agent-level analogue of `turnBelongsToReporter`, for calls that may arrive
 * outside any turn.
 *
 * The calling-turn context (`conversationId`/`turnId`) is ANCHORING, not
 * authority: it decides where a schedule delivers and whose standing it runs
 * under, so it is verified against the fenced agent before use and silently
 * dropped when it does not hold — a forged context degrades a schedule's
 * delivery, never its authorization.
 *
 * Every outcome is a `{ok, result|error}` the MODEL reads. Validation
 * errors are deliberately verbatim ("Invalid schedule expression: …") — the
 * agent is the caller, and a good error IS the fix. Fence failures are the
 * one hint-free case.
 */

interface ToolIdentity {
  agentId: string;
  workspaceId: string;
  organizationId: string;
}

export interface ToolContext {
  originConversationId: string | null;
  createdByUserId: string | null;
  /** The VERIFIED calling turn — null unless it exists under the verified
   * conversation. Provenance consumers use this, never the raw request's. */
  turnId: string | null;
}

/** What the resolved context is FOR — "origin" anchors deliveries (watch/
 * cron reports), "provenance" only records where a write came from. */
export type ContextPurpose = "origin" | "provenance";

/**
 * Verify a claimed calling-turn context against a fenced agent, keeping only
 * what holds (anchoring, not authority — a forged context degrades delivery,
 * never authorization). Shared by the tool-call path and step 10's
 * process.state anchoring so the doctrine lives in exactly one place.
 */
export const resolveVerifiedContext = async (
  agentId: string,
  claim: { conversationId?: string; turnId?: string },
  purpose: ContextPurpose = "origin",
): Promise<ToolContext> => {
  if (!claim.conversationId) {
    return { originConversationId: null, createdByUserId: null, turnId: null };
  }
  const conversation = await db.conversation.findFirst({
    where: { id: claim.conversationId, agentId },
    select: { id: true, source: true },
  });
  if (!conversation) {
    log.warn(
      { agentId, conversationId: claim.conversationId },
      "context claimed a conversation its agent does not hold; ignoring it",
    );
    return { originConversationId: null, createdByUserId: null, turnId: null };
  }
  // An automation-sourced conversation (a cron/watch run) must never become
  // an ORIGIN anchor: nothing renders those threads, so a watch anchored
  // there delivers its report into a black hole — and the mistake chains
  // (a wake turn arming the next watch at its own hidden conversation).
  // Web and Slack conversations stay legal anchors; a rejected claim
  // degrades to no anchor, exactly like a forged one. PROVENANCE consumers
  // (memory revisions) keep the automation conversation — recording that a
  // save came from a cron turn is honest, and nothing is delivered there.
  if (
    purpose === "origin" &&
    (AUTOMATION_SOURCES as readonly string[]).includes(conversation.source)
  ) {
    log.warn(
      { agentId, conversationId: claim.conversationId },
      "context claimed an automation conversation; ignoring it",
    );
    return { originConversationId: null, createdByUserId: null, turnId: null };
  }
  if (!claim.turnId) {
    return {
      originConversationId: conversation.id,
      createdByUserId: null,
      turnId: null,
    };
  }
  const turn = await db.turn.findFirst({
    where: { id: claim.turnId, conversationId: conversation.id },
    select: { id: true, userId: true },
  });
  return {
    originConversationId: conversation.id,
    createdByUserId: turn?.userId ?? null,
    turnId: turn?.id ?? null,
  };
};

const resolveIdentity = async (
  runnerId: string,
  sandboxId: string,
): Promise<ToolIdentity | null> => {
  const sandbox = await db.sandbox.findFirst({
    where: { id: sandboxId, runnerId },
    select: {
      agent: {
        select: {
          id: true,
          workspaceId: true,
          workspace: { select: { organizationId: true } },
        },
      },
    },
  });
  if (!sandbox) return null;
  return {
    agentId: sandbox.agent.id,
    workspaceId: sandbox.agent.workspaceId,
    organizationId: sandbox.agent.workspace.organizationId,
  };
};

/** The tool-call path's context resolution — the shared doctrine, applied to
 * a tool request's claimed ids. */
const resolveContext = (
  identity: ToolIdentity,
  request: RunnerToolCallRequest,
  purpose: ContextPurpose = "origin",
): Promise<ToolContext> =>
  resolveVerifiedContext(
    identity.agentId,
    {
      ...(request.conversationId && {
        conversationId: request.conversationId,
      }),
      ...(request.turnId && { turnId: request.turnId }),
    },
    purpose,
  );

const auditAsCreator = async (
  identity: ToolIdentity,
  createdByUserId: string | null,
  action: (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS],
  service: (typeof AUDIT_SERVICES)[keyof typeof AUDIT_SERVICES],
  metadata: Record<string, string>,
): Promise<void> => {
  // Agent-authored writes are audited under the human whose ask they carry
  // when that human is known; with no resolvable creator there is no honest
  // acting user to attribute (the cron/memory row itself records the null).
  if (!createdByUserId) return;
  const user = await db.user.findUnique({
    where: { id: createdByUserId },
    select: { email: true },
  });
  if (!user) return;
  await recordAuditEvent({
    workspaceId: identity.workspaceId,
    userId: createdByUserId,
    userEmail: user.email,
    action,
    service,
    source: AUDIT_SOURCE.API,
    metadata: { ...metadata, agentId: identity.agentId, viaAgent: "true" },
  });
};

const toolError = (message: string): RunnerToolCallResponse => ({
  ok: false,
  error: message,
});

/**
 * The ONE agent-authored memory write path shared by both doors (the
 * `memory_save` tool and the `memory.write` file harvest): resolve the
 * via-user, build the agent author, run the door's own save, and audit —
 * but NEVER on a no-op (re-saving byte-identical content minted no revision,
 * so an audit row would record a change that did not happen). Extracted so
 * the two doors cannot drift on the no-op-audit rule (they did: the tool
 * door audited every save unconditionally while the file door already
 * skipped no-ops).
 */
const saveMemoryAudited = async (
  identity: ToolIdentity,
  context: ToolContext,
  save: (
    author: MemoryAuthor,
  ) => Promise<{ memory: AgentMemoryView; created: boolean; noop: boolean }>,
  extraMeta: Record<string, string> = {},
): Promise<{ memory: AgentMemoryView; created: boolean; noop: boolean }> => {
  // Denormalize the via-user's email into the revision (the AuditLog
  // convention): "whose ask this write carried" must survive that user's
  // deletion, which SetNulls the FK.
  const viaUser = context.createdByUserId
    ? await db.user.findUnique({
        where: { id: context.createdByUserId },
        select: { email: true },
      })
    : null;
  const result = await save({
    authorKind: "agent",
    authorUserId: context.createdByUserId,
    authorEmail: viaUser?.email ?? null,
    conversationId: context.originConversationId,
    turnId: context.turnId,
  });
  if (!result.noop) {
    await auditAsCreator(
      identity,
      context.createdByUserId,
      result.created ? AUDIT_ACTIONS.CREATE : AUDIT_ACTIONS.UPDATE,
      AUDIT_SERVICES.MEMORY,
      { memoryId: result.memory.id, key: result.memory.key, ...extraMeta },
    );
  }
  return result;
};

/**
 * memory_get's content budget, measured on the SERIALIZED result (the runner
 * drops a `tool.result` whose `JSON.stringify(result).length` exceeds
 * MAX_TOOL_RESULT_CHARS — a char clip would fail exactly the escape-dense
 * content it exists to handle, since a quote/backslash/newline serializes to
 * 2 chars and a control char to 6). The margin below MAX_TOOL_RESULT_CHARS
 * leaves room for the envelope (key/title/description/note/updatedAt). */
export const MEMORY_GET_RESULT_BUDGET_CHARS = MAX_TOOL_RESULT_CHARS - 4_000;

/**
 * Clip `content` so a result object carrying it serializes under `budget`.
 * Only `content` is large, so we measure the whole result once, then — if
 * over — proportionally clip and trim the remainder in bounded steps. Returns
 * the (possibly clipped) content and whether it was clipped.
 */
const clipContentToResultBudget = (
  build: (content: string) => Record<string, unknown>,
  content: string,
  budget: number,
): { content: string; truncated: boolean } => {
  if (JSON.stringify(build(content)).length <= budget) {
    return { content, truncated: false };
  }
  // Proportional first cut (serialized length is ~monotonic in char count),
  // then shrink until it fits — content dominates, so this converges fast.
  const serialized = JSON.stringify(build(content)).length;
  let n = Math.floor((content.length * budget) / serialized);
  while (n > 0 && JSON.stringify(build(content.slice(0, n))).length > budget) {
    n -= 2_048;
  }
  return { content: content.slice(0, Math.max(0, n)), truncated: true };
};

/**
 * Pacing for the file-write door (per sandbox): a hostile or looping
 * supervisor could otherwise mint a 100k-content revision (plus a home
 * re-push) as fast as it can round-trip. Burst covers a boot harvest of a
 * realistic edit set; the refill covers a diligent agent. In-process by
 * design — this is DoS mitigation, not accounting — and keyed only AFTER the
 * identity fence, so the map is bounded by real sandboxes.
 */
export const MEMORY_WRITE_BUCKET_CAPACITY = 20;
export const MEMORY_WRITE_REFILL_PER_SECOND = 0.5;

interface WriteBucket {
  tokens: number;
  last: number;
}

const memoryWriteBuckets = new Map<string, WriteBucket>();

/** Exported as a test seam (the `now` parameter lets a test drive the clock
 * without mocking `Date`); production callers pass no `now`. */
export const takeMemoryWriteToken = (
  sandboxId: string,
  now: number = Date.now(),
): boolean => {
  const bucket = memoryWriteBuckets.get(sandboxId) ?? {
    tokens: MEMORY_WRITE_BUCKET_CAPACITY,
    last: now,
  };
  // `Math.max(0, …)` on the elapsed: `Date.now()` is wall-clock, so an NTP
  // step-back or a VM pause/resume on the API host can hand us a negative
  // delta — without the floor that SUBTRACTS tokens (no lower clamp), locking
  // a sandbox out of memory writes for the length of the step. Time going
  // backwards must never spend tokens, only fail to add them.
  const elapsedMs = Math.max(0, now - bucket.last);
  bucket.tokens = Math.min(
    MEMORY_WRITE_BUCKET_CAPACITY,
    bucket.tokens + (elapsedMs / 1000) * MEMORY_WRITE_REFILL_PER_SECOND,
  );
  bucket.last = now;
  const allowed = bucket.tokens >= 1;
  if (allowed) bucket.tokens -= 1;
  // Evict a bucket that has refilled to the brim (the sandbox is idle or gone):
  // keeping it would let the map grow by every sandbox EVER seen over a
  // long-lived api-server, not the live set. A returning sandbox just starts
  // full again — which is exactly a full bucket's meaning.
  if (bucket.tokens >= MEMORY_WRITE_BUCKET_CAPACITY) {
    memoryWriteBuckets.delete(sandboxId);
  } else {
    memoryWriteBuckets.set(sandboxId, bucket);
  }
  return allowed;
};

/** Test seam: pacing state must not leak between suites. */
export const resetMemoryWritePacing = (): void => {
  memoryWriteBuckets.clear();
};

/**
 * The FILE-WRITE door (the projection's write-back half): the runner is
 * relaying a harvested `memory/` edit from a sandbox it hosts. Identical
 * trust posture to a tool call — identity DERIVED from the two authenticated
 * facts, hint-free fence failure, claimed turn context verified before use —
 * plus write pacing, because this door carries the big content cap.
 */
export const executeMemoryFileWrite = async (
  runnerId: string,
  request: RunnerMemoryWriteRequest,
): Promise<RunnerMemoryWriteResponse> => {
  const identity = await resolveIdentity(runnerId, request.sandboxId);
  if (!identity) {
    log.warn(
      { runnerId, sandboxId: request.sandboxId },
      "memory write from a sandbox this runner does not host",
    );
    return { ok: false, error: "This write is not available." };
  }
  if (!takeMemoryWriteToken(request.sandboxId)) {
    return {
      ok: false,
      retryable: true,
      error: "Memory writes are being paced. Retry shortly.",
    };
  }

  try {
    const context = await resolveVerifiedContext(
      identity.agentId,
      {
        ...(request.conversationId && {
          conversationId: request.conversationId,
        }),
        ...(request.turnId && { turnId: request.turnId }),
      },
      "provenance",
    );
    const { memory, created, noop } = await saveMemoryAudited(
      identity,
      context,
      (author) =>
        saveMemoryFromFile(
          identity.workspaceId,
          identity.agentId,
          {
            key: request.key,
            content: request.content,
            ...(request.title !== undefined && { title: request.title }),
            ...(request.description !== undefined && {
              description: request.description,
            }),
          },
          author,
        ),
      { viaFile: "true" },
    );
    return {
      ok: true,
      created,
      noop,
      revisionSeq: memory.lastRevisionSeq,
    };
  } catch (error) {
    if (error instanceof ServiceError) {
      // A refusal (caps, empty content) is terminal for THIS content — the
      // harvester waits for the file to change rather than retrying.
      return { ok: false, error: error.message };
    }
    log.error({ error, key: request.key }, "memory file write failed");
    return {
      ok: false,
      retryable: true,
      error: "The write failed unexpectedly.",
    };
  }
};

export const executePlatformTool = async (
  runnerId: string,
  request: RunnerToolCallRequest,
): Promise<RunnerToolCallResponse> => {
  const identity = await resolveIdentity(runnerId, request.sandboxId);
  if (!identity) {
    // Hint-free, like every fence: a relay for a sandbox this runner does
    // not hold learns nothing about what else exists.
    log.warn(
      { runnerId, sandboxId: request.sandboxId },
      "tool call from a sandbox this runner does not host",
    );
    return toolError("This tool is not available.");
  }

  try {
    switch (request.tool) {
      case "schedule_task": {
        const args = scheduleTaskArgsSchema.safeParse(request.args);
        if (!args.success) {
          return toolError(args.error.issues[0]?.message ?? "Invalid input");
        }
        const context = await resolveContext(identity, request);
        const cron = await createCron(
          identity.workspaceId,
          identity.agentId,
          args.data,
          context,
        );
        await auditAsCreator(
          identity,
          context.createdByUserId,
          AUDIT_ACTIONS.CREATE,
          AUDIT_SERVICES.CRON,
          { cronId: cron.id, name: cron.name },
        );
        // A schedule with no occurrence after its first is a one-shot: it
        // fires once, reports, and completes. Derived from the expression
        // (croner is the single authority), never stored.
        const runsOnce =
          nextFireOrNull(cron.schedule, cron.timezone, cron.nextFireAt) ===
          null;
        return {
          ok: true,
          result: {
            cronId: cron.id,
            name: cron.name,
            schedule: cron.schedule,
            timezone: cron.timezone,
            nextFireAt: cron.nextFireAt.toISOString(),
            runsOnce,
            note: runsOnce
              ? context.originConversationId
                ? `Scheduled. Runs once at ${cron.nextFireAt.toISOString()}, then completes; the report is delivered to this chat.`
                : "Scheduled to run once. The run will appear on the agent's Schedules page (this call carried no chat to deliver to)."
              : context.originConversationId
                ? "Scheduled. Each run reports back to this chat."
                : "Scheduled. Runs will appear on the agent's Schedules page (this call carried no chat to deliver to).",
          },
        };
      }

      case "list_tasks": {
        const crons = await listCrons(identity.workspaceId, identity.agentId);
        return {
          ok: true,
          result: {
            tasks: crons.map((cron) => ({
              cronId: cron.id,
              name: cron.name,
              schedule: cron.schedule,
              timezone: cron.timezone,
              enabled: cron.enabled,
              ...(cron.disabledReason && {
                disabledReason: cron.disabledReason,
              }),
              nextFireAt: cron.nextFireAt.toISOString(),
              ...(cron.lastOutcome && { lastOutcome: cron.lastOutcome }),
            })),
          },
        };
      }

      case "cancel_task": {
        const args = cancelTaskArgsSchema.safeParse(request.args);
        if (!args.success) {
          return toolError(args.error.issues[0]?.message ?? "Invalid input");
        }
        const context = await resolveContext(identity, request);
        await deleteCron(
          identity.workspaceId,
          identity.agentId,
          args.data.cronId,
        );
        await auditAsCreator(
          identity,
          context.createdByUserId,
          AUDIT_ACTIONS.DELETE,
          AUDIT_SERVICES.CRON,
          { cronId: args.data.cronId },
        );
        return { ok: true, result: { cancelled: args.data.cronId } };
      }

      case "memory_save": {
        const args = memorySaveArgsSchema.safeParse(request.args);
        if (!args.success) {
          return toolError(args.error.issues[0]?.message ?? "Invalid input");
        }
        const context = await resolveContext(identity, request, "provenance");
        const { memory, created } = await saveMemoryAudited(
          identity,
          context,
          (author) =>
            upsertMemoryByKey(
              identity.workspaceId,
              identity.agentId,
              args.data,
              author,
            ),
        );
        return {
          ok: true,
          result: {
            key: memory.key,
            created,
            revisionSeq: memory.lastRevisionSeq,
          },
        };
      }

      case "memory_list": {
        const args = memoryListArgsSchema.safeParse(request.args ?? {});
        if (!args.success) {
          return toolError(args.error.issues[0]?.message ?? "Invalid input");
        }
        const [memories, pressure] = await Promise.all([
          listMemories(identity.workspaceId, identity.agentId),
          memoryPressure(identity.agentId),
        ]);
        return {
          ok: true,
          result: {
            memories: memories.map((memory) => ({
              key: memory.key,
              ...(memory.title && { title: memory.title }),
              ...(memory.description && { description: memory.description }),
              updatedAt: memory.updatedAt.toISOString(),
            })),
            held: pressure.held,
            max: pressure.max,
          },
        };
      }

      case "memory_search": {
        const args = memorySearchArgsSchema.safeParse(request.args);
        if (!args.success) {
          return toolError(args.error.issues[0]?.message ?? "Invalid input");
        }
        const hits = await searchMemoriesForWorkspace(
          identity.workspaceId,
          identity.agentId,
          args.data.query,
        );
        return {
          ok: true,
          result: {
            matches: hits.map((hit) => ({
              key: hit.key,
              ...(hit.title && { title: hit.title }),
              ...(hit.description && { description: hit.description }),
              snippet: hit.snippet,
              updatedAt: hit.updatedAt.toISOString(),
            })),
          },
        };
      }

      case "memory_get": {
        const args = memoryGetArgsSchema.safeParse(request.args);
        if (!args.success) {
          return toolError(args.error.issues[0]?.message ?? "Invalid input");
        }
        const memory = await getMemoryByKey(
          identity.workspaceId,
          identity.agentId,
          args.data.key,
        );
        // File-authored memories may exceed what a tool result can carry
        // (the runner bounds SERIALIZED results and answers with a delivery
        // error, which reads as a broken tool) — clip against that serialized
        // budget HERE, say so, and point at the projected file, which always
        // has the full body.
        const note = `Truncated — read memory/${memory.key}.md in your home for the full body.`;
        const buildResult = (content: string, truncated: boolean) => ({
          key: memory.key,
          ...(memory.title && { title: memory.title }),
          ...(memory.description && { description: memory.description }),
          content,
          ...(truncated && { contentTruncated: true, note }),
          updatedAt: memory.updatedAt.toISOString(),
        });
        const clipped = clipContentToResultBudget(
          (content) => buildResult(content, true),
          memory.content,
          MEMORY_GET_RESULT_BUDGET_CHARS,
        );
        return {
          ok: true,
          result: buildResult(clipped.content, clipped.truncated),
        };
      }

      case "skill_create": {
        const args = skillCreateArgsSchema.safeParse(request.args);
        if (!args.success) {
          return toolError(args.error.issues[0]?.message ?? "Invalid input");
        }
        const context = await resolveContext(identity, request, "provenance");
        // Denormalize the via-user's email into the row (the memory-revision
        // convention): "whose ask this write carried" must survive that
        // user's deletion, which SetNulls the FK.
        const viaUser = context.createdByUserId
          ? await db.user.findUnique({
              where: { id: context.createdByUserId },
              select: { email: true },
            })
          : null;
        const skill = await createSkill(
          identity.workspaceId,
          { ...args.data, agentId: identity.agentId },
          { userId: context.createdByUserId, email: viaUser?.email ?? null },
        );
        await auditAsCreator(
          identity,
          context.createdByUserId,
          AUDIT_ACTIONS.CREATE,
          AUDIT_SERVICES.SKILL,
          { skillId: skill.id, name: skill.name },
        );
        return {
          ok: true,
          result: {
            name: skill.name,
            scope: skill.scope,
            enabled: skill.enabled,
            note: `Created. It materializes into your skills directory as ${skill.name}/SKILL.md within seconds and also appears on your Skills page in the dashboard.`,
          },
        };
      }

      case "skill_list": {
        const args = skillListArgsSchema.safeParse(request.args ?? {});
        if (!args.success) {
          return toolError(args.error.issues[0]?.message ?? "Invalid input");
        }
        const skills = await listSkillsReachingAgent(
          identity.agentId,
          identity.workspaceId,
          identity.organizationId,
        );
        return {
          ok: true,
          result: {
            skills: skills.map((skill) => ({
              name: skill.name,
              scope: skill.scope,
              description: skill.description,
              enabled: skill.enabled,
              // Editable = yours: only agent-tier rows answer skill_update/
              // skill_delete; the rest are managed in the dashboard.
              editable: skill.scope === "agent",
            })),
            note: "When the same name exists at several scopes, the most specific one wins for you (agent > workspace > organization). Disabled skills are not materialized.",
          },
        };
      }

      case "skill_update": {
        const args = skillUpdateArgsSchema.safeParse(request.args);
        if (!args.success) {
          return toolError(args.error.issues[0]?.message ?? "Invalid input");
        }
        const context = await resolveContext(identity, request, "provenance");
        const { name, ...patch } = args.data;
        const { skill, noop } = await updateAgentSkillByName(
          identity.agentId,
          identity.workspaceId,
          identity.organizationId,
          name,
          patch,
        );
        if (!noop) {
          await auditAsCreator(
            identity,
            context.createdByUserId,
            AUDIT_ACTIONS.UPDATE,
            AUDIT_SERVICES.SKILL,
            { skillId: skill.id, name, fields: Object.keys(patch).join(",") },
          );
        }
        return {
          ok: true,
          result: {
            name: skill.name,
            enabled: skill.enabled,
            noop,
            note: noop
              ? "Nothing changed — the skill already held these values."
              : `Updated. Your home re-syncs within seconds${skill.enabled ? "" : "; a disabled skill's files leave your skills directory"}.`,
          },
        };
      }

      case "skill_delete": {
        const args = skillDeleteArgsSchema.safeParse(request.args);
        if (!args.success) {
          return toolError(args.error.issues[0]?.message ?? "Invalid input");
        }
        const context = await resolveContext(identity, request, "provenance");
        const deleted = await deleteAgentSkillByName(
          identity.agentId,
          identity.workspaceId,
          identity.organizationId,
          args.data.name,
        );
        await auditAsCreator(
          identity,
          context.createdByUserId,
          AUDIT_ACTIONS.DELETE,
          AUDIT_SERVICES.SKILL,
          { skillId: deleted.id, name: args.data.name },
        );
        return {
          ok: true,
          result: {
            deleted: args.data.name,
            note: "Its files leave your skills directory within seconds.",
          },
        };
      }

      default:
        return toolError(`Unknown tool "${request.tool}".`);
    }
  } catch (error) {
    if (error instanceof ServiceError) {
      // The model is the caller: a service refusal ("Invalid schedule
      // expression", "Schedule not found") is exactly the feedback it needs.
      return toolError(error.message);
    }
    log.error({ error, tool: request.tool }, "platform tool failed");
    return toolError("The tool failed unexpectedly. Try again.");
  }
};
