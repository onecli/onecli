import { createHash } from "node:crypto";
import { db, Prisma } from "@onecli/db";
import { z } from "zod";
import { ServiceError } from "./errors";
import { createConversation } from "./conversation-service";
import { abortTurn, createTurn } from "./turn-service";
import { getEvalRunEvidence } from "./agent-runs-service";
import { scoreEval } from "./eval-scoring";
import { judgeAnswer } from "./eval-judge";
import {
  loadAgentForLlm,
  resolveAgentLlmCredential,
} from "./llm-credential-service";
import { resolveAgentModel } from "../llm/resolve";
import { logger } from "../lib/logger";
import {
  ACTIVE_TURN_STATUSES,
  EVAL_SOURCE,
  TURN_FAILED_RAW_ERROR_MESSAGE,
  isRawErrorPayload,
} from "../validations/conversation";
import { RUN_WINDOW_SLACK_MS } from "../validations/runs";
import {
  ACTIVE_EVAL_RUN_STATUSES,
  EVAL_CHECK_KINDS,
  EVAL_QUESTIONS_MAX,
  EVAL_RUN_STATUSES,
  EVAL_RUNS_LISTED,
  EVAL_RUN_TRIGGERS,
  NUMERIC_EXPECTED_MESSAGE,
  countEvalOutcomes,
  evalResultSchema,
  parseNumericExpected,
  type EvalCheckKind,
  type EvalOutcomeCounts,
  type EvalQuestionBody,
  type EvalResult,
  type EvalResultView,
  type EvalRunStatus,
  type EvalRunTrigger,
} from "../validations/evals";
import { compareToPrevious } from "./eval-comparison";

/**
 * Agent EVALS: test questions with known answers, asked of the live agent
 * through the ordinary turn path (one fresh `eval` conversation per
 * question) so a run exercises exactly what a user gets. Each answer is
 * scored by a simple check (or, for a custom check, by an AI judge applying
 * the author's own success criteria) plus the apps the agent reached, and
 * every run keeps a snapshot of its questions and results.
 *
 * The worker runs in the API process that accepted the run. If that process
 * dies (a deploy, a crash), the run stops making progress; the next run
 * request marks it failed once it has been idle for STALE_RUN_MS and no eval
 * turn of this agent is still active, so an agent is never locked out.
 */

/** How long one question may run before it is stopped and scored an error. */
const QUESTION_TIMEOUT_MS = 5 * 60_000;
/** How long a stop request may take to settle the turn. */
const ABORT_SETTLE_MS = 30_000;
const POLL_MS = 1_500;
/** Let the gateway rows land and keep consecutive questions' evidence
 * windows apart, so one question never overlaps the previous one. */
const EVIDENCE_SETTLE_MS = 2 * RUN_WINDOW_SLACK_MS + 500;
/** An active run with no checkpoint for this long has lost its worker. A
 * live worker checkpoints at least once per question, and one question
 * takes at most QUESTION_TIMEOUT_MS + ABORT_SETTLE_MS + EVIDENCE_SETTLE_MS
 * (about 5.6 minutes), plus a custom check's judge (two attempts of at most
 * a minute each, `eval-judge.ts`): under 8 minutes in all. */
export const STALE_RUN_MS = 10 * 60_000;

export interface EvalQuestion {
  id: string;
  question: string;
  expected: string;
  kind: EvalCheckKind;
  expectedApps: string[];
}

/** A run in the history list: its status and outcome counts. */
export interface EvalRunSummary {
  id: string;
  status: EvalRunStatus;
  /** Who started it: a person (`manual`) or the eval schedule. */
  trigger: EvalRunTrigger;
  configVersion: string;
  /** The model the agent answered with; null on older runs, or with no key. */
  model: string | null;
  total: number;
  counts: EvalOutcomeCounts;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** One run in full: every result, each compared with the previous
 * completed run of the same agent. */
export interface EvalRunDetail extends EvalRunSummary {
  results: EvalResultView[];
  /** The run the results are compared with, or null when there is none. */
  previous: { id: string; configVersion: string } | null;
}

const log = logger.child({ component: "agent-evals" });

/** The eval fence every entry point shares (questions, runs, the schedule):
 * the agent must be this workspace's, and hosted. */
export const requireHostedAgent = async (
  workspaceId: string,
  agentId: string,
) => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId },
    select: { kind: true },
  });
  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");
  if (agent.kind !== "hosted")
    throw new ServiceError(
      "UNPROCESSABLE",
      "Evals run against hosted agents only",
    );
};

/** Serialize this agent's eval writes (the question cap, run admission)
 * across requests and API instances. */
const lockAgent = async (
  tx: Prisma.TransactionClient,
  workspaceId: string,
  agentId: string,
) => {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM agents
    WHERE id = ${agentId} AND workspace_id = ${workspaceId}
    FOR UPDATE
  `;
  if (rows.length === 0) throw new ServiceError("NOT_FOUND", "Agent not found");
};

// ── Configuration fingerprint ──────────────────────────────────────────────

/** A PARTIAL fingerprint of the agent's configuration: instructions, model,
 * effort, enabled skill names and content, and granted rule IDs. It does
 * not capture rule bodies, credentials, memory, or the data the agent
 * reads, so a changed answer under the same fingerprint is not proof of a
 * regression, and a changed fingerprint is not proof of the cause. */
const agentConfigVersion = async (
  tx: Prisma.TransactionClient,
  agentId: string,
): Promise<string> => {
  const [agent, skills, grants] = await Promise.all([
    tx.agent.findUniqueOrThrow({
      where: { id: agentId },
      select: { instructions: true, model: true, effort: true },
    }),
    tx.skill.findMany({
      where: { agentId, enabled: true },
      select: { name: true, content: true },
      orderBy: { name: "asc" },
    }),
    tx.policyRuleIdentity.findMany({
      where: { agentId },
      select: { ruleId: true },
      orderBy: { ruleId: "asc" },
    }),
  ]);
  const hash = createHash("sha256").update(JSON.stringify(agent));
  for (const s of skills) hash.update(`${s.name}\0${s.content}\0`);
  hash.update(grants.map((g) => g.ruleId).join(","));
  return `cfg_${hash.digest("hex").slice(0, 10)}`;
};

// ── Questions ──────────────────────────────────────────────────────────────

const questionSelect = {
  id: true,
  question: true,
  expected: true,
  kind: true,
  expectedApps: true,
} satisfies Prisma.AgentEvalQuestionSelect;

const toQuestion = (
  row: Prisma.AgentEvalQuestionGetPayload<{ select: typeof questionSelect }>,
): EvalQuestion => ({
  ...row,
  kind: z.enum(EVAL_CHECK_KINDS).parse(row.kind),
});

const activeQuestions = (
  client: Prisma.TransactionClient,
  workspaceId: string,
  agentId: string,
) =>
  client.agentEvalQuestion.findMany({
    where: { agentId, agent: { workspaceId }, archived: false },
    select: questionSelect,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

export const listQuestions = async (
  workspaceId: string,
  agentId: string,
): Promise<EvalQuestion[]> => {
  await requireHostedAgent(workspaceId, agentId);
  return (await activeQuestions(db, workspaceId, agentId)).map(toQuestion);
};

/** Create a question, or edit an ACTIVE one. Archived questions are
 * history: they are never edited or restored. */
export const saveQuestion = async (
  workspaceId: string,
  agentId: string,
  questionId: string | null,
  input: EvalQuestionBody,
): Promise<EvalQuestion> => {
  await requireHostedAgent(workspaceId, agentId);
  // The route parses with evalQuestionSchema; re-checked here because the
  // scorer depends on it, with the schema's own message.
  if (input.kind === "numeric" && parseNumericExpected(input.expected) === null)
    throw new ServiceError("UNPROCESSABLE", NUMERIC_EXPECTED_MESSAGE);
  return db.$transaction(async (tx) => {
    await lockAgent(tx, workspaceId, agentId);
    const scope = { agentId, agent: { workspaceId }, archived: false };
    if (questionId !== null) {
      const { count } = await tx.agentEvalQuestion.updateMany({
        where: { ...scope, id: questionId },
        data: input,
      });
      if (count === 0)
        throw new ServiceError("NOT_FOUND", "Test question not found");
      return toQuestion(
        await tx.agentEvalQuestion.findUniqueOrThrow({
          where: { id: questionId },
          select: questionSelect,
        }),
      );
    }
    if (
      (await tx.agentEvalQuestion.count({ where: scope })) >= EVAL_QUESTIONS_MAX
    )
      throw new ServiceError(
        "UNPROCESSABLE",
        `An agent can have at most ${EVAL_QUESTIONS_MAX} test questions`,
      );
    return toQuestion(
      await tx.agentEvalQuestion.create({
        data: { ...input, agentId },
        select: questionSelect,
      }),
    );
  });
};

/** Remove a question from future runs. Past results keep their snapshot. */
export const archiveQuestion = async (
  workspaceId: string,
  agentId: string,
  questionId: string,
) => {
  await requireHostedAgent(workspaceId, agentId);
  const { count } = await db.agentEvalQuestion.updateMany({
    where: { id: questionId, agentId, agent: { workspaceId }, archived: false },
    data: { archived: true },
  });
  if (count === 0)
    throw new ServiceError("NOT_FOUND", "Test question not found");
};

// ── Runs ───────────────────────────────────────────────────────────────────

const runSelect = {
  id: true,
  status: true,
  trigger: true,
  configVersion: true,
  model: true,
  total: true,
  results: true,
  error: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
} satisfies Prisma.AgentEvalRunSelect;
type RunRow = Prisma.AgentEvalRunGetPayload<{ select: typeof runSelect }>;

const storedResults = z.array(evalResultSchema);

/** Shown on a run whose stored results this version cannot read (written by
 * an older format). */
const UNREADABLE_RUN_ERROR =
  "This run was recorded in an older format and its results cannot be shown.";

/** A stored run, parsed. A row whose results do not parse (an older format)
 * must not take the whole Evals screen down with it: it reads as a failed
 * run with no results, and the detail stays in the server log. */
const parseRun = (row: RunRow) => {
  const parsed = storedResults.safeParse(row.results);
  if (!parsed.success)
    log.warn(
      { runId: row.id, issues: parsed.error.issues.length },
      "eval run results could not be read",
    );
  const results = parsed.success ? parsed.data : [];
  return {
    results,
    summary: {
      id: row.id,
      status: parsed.success
        ? z.enum(EVAL_RUN_STATUSES).parse(row.status)
        : "failed",
      trigger: z.enum(EVAL_RUN_TRIGGERS).catch("manual").parse(row.trigger),
      configVersion: row.configVersion,
      model: row.model,
      total: row.total,
      counts: countEvalOutcomes(results, parsed.success ? row.total : 0),
      error: parsed.success ? row.error : UNREADABLE_RUN_ERROR,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    } satisfies EvalRunSummary,
  };
};

export const listRuns = async (
  workspaceId: string,
  agentId: string,
): Promise<EvalRunSummary[]> => {
  await requireHostedAgent(workspaceId, agentId);
  const rows = await db.agentEvalRun.findMany({
    where: { agentId, agent: { workspaceId } },
    select: runSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: EVAL_RUNS_LISTED,
  });
  return rows.map((row) => parseRun(row).summary);
};

export const getRun = async (
  workspaceId: string,
  agentId: string,
  runId: string,
): Promise<EvalRunDetail> => {
  const row = await db.agentEvalRun.findFirst({
    where: { id: runId, agentId, agent: { workspaceId } },
    select: runSelect,
  });
  if (!row) throw new ServiceError("NOT_FOUND", "Eval run not found");
  const { summary, results } = parseRun(row);
  // The latest COMPLETED run before this one is the baseline.
  const previousRow = await db.agentEvalRun.findFirst({
    where: {
      agentId,
      agent: { workspaceId },
      status: "done",
      OR: [
        { createdAt: { lt: row.createdAt } },
        { createdAt: row.createdAt, id: { lt: row.id } },
      ],
    },
    select: runSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const previous = previousRow ? parseRun(previousRow) : null;
  return {
    ...summary,
    results: compareToPrevious(results, previous?.results ?? null),
    previous: previous && {
      id: previous.summary.id,
      configVersion: previous.summary.configVersion,
    },
  };
};

/**
 * Mark this agent's stale runs failed: active, no checkpoint for
 * STALE_RUN_MS, and no eval turn of the agent still active. A run whose
 * turn is still going is never failed under it.
 */
const failStaleRuns = async (
  tx: Prisma.TransactionClient,
  workspaceId: string,
  agentId: string,
) => {
  const activeTurn = await tx.turn.findFirst({
    where: {
      source: EVAL_SOURCE,
      status: { in: [...ACTIVE_TURN_STATUSES] },
      conversation: { agentId, agent: { workspaceId }, source: EVAL_SOURCE },
    },
    select: { id: true },
  });
  if (activeTurn) return;
  await tx.agentEvalRun.updateMany({
    where: {
      agentId,
      status: { in: [...ACTIVE_EVAL_RUN_STATUSES] },
      updatedAt: { lt: new Date(Date.now() - STALE_RUN_MS) },
    },
    data: {
      status: "failed",
      finishedAt: new Date(),
      error: "The run stopped making progress and was ended.",
    },
  });
};

/** A run was asked of an agent with no active test questions. Still the
 * same 422 to a person pressing Run tests; typed so the eval schedule can
 * tell it apart from any other refusal, decided inside the admission lock. */
export class NoEvalQuestionsError extends ServiceError {
  constructor() {
    super("UNPROCESSABLE", "Add a test question first");
  }
}

/**
 * The model this agent runs right now, exactly as its sandbox resolves it
 * (`sandbox-service`): the stored choice when it belongs to the granted
 * key's provider, else that provider's default. Null when it has no key.
 */
const agentRunModel = async (
  workspaceId: string,
  organizationId: string,
  agentId: string,
): Promise<string | null> => {
  const agent = await loadAgentForLlm(workspaceId, agentId);
  if (!agent) return null;
  const credential = await resolveAgentLlmCredential(agent, organizationId);
  return credential
    ? resolveAgentModel(agent, credential.provider).model
    : null;
};

/** Admit one run per agent: no active run and no active eval turn. The
 * worker starts after the admission commits. `scheduled` runs come from the
 * eval schedule (`eval-schedule-fire-service.ts`), on its creator's
 * authority. */
export const startRun = async (
  workspaceId: string,
  organizationId: string,
  userId: string,
  agentId: string,
  trigger: EvalRunTrigger = "manual",
): Promise<EvalRunSummary> => {
  await requireHostedAgent(workspaceId, agentId);
  // Resolved before the admission lock: it reads the key (several queries),
  // and nothing it reads needs the lock. Like the configuration fingerprint,
  // it is the model at admission.
  const model = await agentRunModel(workspaceId, organizationId, agentId);
  const { run, questions } = await db.$transaction(async (tx) => {
    await lockAgent(tx, workspaceId, agentId);
    await failStaleRuns(tx, workspaceId, agentId);
    const busy = await tx.agentEvalRun.findFirst({
      where: { agentId, status: { in: [...ACTIVE_EVAL_RUN_STATUSES] } },
      select: { id: true },
    });
    if (busy) throw new ServiceError("CONFLICT", "Tests are already running");
    const questions = (await activeQuestions(tx, workspaceId, agentId)).map(
      toQuestion,
    );
    if (questions.length === 0) throw new NoEvalQuestionsError();
    const run = await tx.agentEvalRun.create({
      data: {
        agentId,
        createdByUserId: userId,
        trigger,
        configVersion: await agentConfigVersion(tx, agentId),
        model,
        total: questions.length,
      },
      select: runSelect,
    });
    return { run: parseRun(run).summary, questions };
  });
  void executeRun(
    { workspaceId, organizationId, userId, agentId, model },
    run.id,
    questions,
  );
  return run;
};

// ── The worker ─────────────────────────────────────────────────────────────

interface RunContext {
  workspaceId: string;
  organizationId: string;
  userId: string;
  agentId: string;
  /** The model the run was admitted on. The judge grades on it, falling
   * back to the provider's default when it cannot run it (`eval-judge`). */
  model: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Failure text a dashboard reader may see. A ServiceError carries
 * user-facing text and the worker's own errors are written for the reader;
 * anything else (a database or runtime error) is shown generically, and its
 * detail stays in the server log, so no internal text lands on a run. */
class RunError extends Error {}
const messageOf = (err: unknown) =>
  err instanceof ServiceError || err instanceof RunError
    ? err.message
    : "Something unexpected went wrong.";

/** Poll a turn until it settles or the deadline passes. */
const waitForTurn = async (turnId: string, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const turn = await db.turn.findUniqueOrThrow({
      where: { id: turnId },
      select: { status: true, error: true },
    });
    if (!(ACTIVE_TURN_STATUSES as readonly string[]).includes(turn.status))
      return turn;
    if (Date.now() >= deadline) return null;
    await sleep(POLL_MS);
  }
};

/** Why a settled turn did not complete, or null when it did. */
const turnFailure = (turn: { status: string; error: string | null }) => {
  if (turn.error && isRawErrorPayload(turn.error))
    return TURN_FAILED_RAW_ERROR_MESSAGE;
  return turn.status === "done"
    ? turn.error
    : (turn.error ?? (turn.status === "aborted" ? "Stopped" : "Failed"));
};

/** A thrown question outcome the run cannot continue past: the turn may
 * still be running, so asking the next question could overlap it. */
class UnsettledTurnError extends RunError {}

/**
 * Ask one question and score it. Checkpoints the identifiers as soon as
 * they exist. Throws UnsettledTurnError when the turn could not be stopped;
 * every other failure is scored as an `error` result.
 */
const askQuestion = async (
  ctx: RunContext,
  q: EvalQuestion,
  checkpoint: (result: EvalResult) => Promise<void>,
): Promise<EvalResult> => {
  const result: EvalResult = {
    questionId: q.id,
    question: q.question,
    expected: q.expected,
    kind: q.kind,
    expectedApps: q.expectedApps,
    outcome: "pending",
    answer: null,
    missingApps: null,
    turnId: null,
    conversationId: null,
    error: null,
    judgement: null,
    judgeError: null,
  };
  const scoreAsError = (error: string): EvalResult => ({
    ...result,
    outcome: "error",
    error,
  });
  try {
    const conversation = await createConversation(ctx.workspaceId, {
      agentId: ctx.agentId,
      source: EVAL_SOURCE,
      title: `Test: ${q.question.slice(0, 80)}`,
    });
    result.conversationId = conversation.id;
    const turn = await createTurn(
      ctx.workspaceId,
      conversation.id,
      q.question,
      { source: EVAL_SOURCE, userId: ctx.userId },
    );
    result.turnId = turn.id;
    await checkpoint(result);

    let settled = await waitForTurn(turn.id, QUESTION_TIMEOUT_MS);
    let failure: string | null;
    if (settled) {
      failure = turnFailure(settled);
    } else {
      // A late answer still counts as timed out: the question had its time.
      failure = "Timed out";
      try {
        await abortTurn(ctx.workspaceId, turn.id, ctx.userId);
      } catch (err) {
        log.warn(
          { err, turnId: turn.id },
          "could not stop a timed-out eval turn",
        );
        failure += `; the stop request failed: ${messageOf(err)}`;
      }
      settled = await waitForTurn(turn.id, ABORT_SETTLE_MS);
      if (!settled) {
        await checkpoint(scoreAsError(`${failure}; the turn did not stop`));
        throw new UnsettledTurnError(
          "A question did not stop after timing out, so the remaining questions were not asked",
        );
      }
    }

    await sleep(EVIDENCE_SETTLE_MS);
    const evidence = await getEvalRunEvidence(
      ctx.workspaceId,
      ctx.organizationId,
      ctx.userId,
      ctx.agentId,
      turn.id,
      q.expectedApps,
    );
    // A custom check is decided by the judge, on the finished answer only:
    // an unfinished turn is an `error` whatever the judge would say.
    const judged =
      q.kind === "custom" && failure === null && evidence.answer !== null
        ? await judgeAnswer({
            agent: { id: ctx.agentId, workspaceId: ctx.workspaceId },
            organizationId: ctx.organizationId,
            model: ctx.model,
            question: q.question,
            criteria: q.expected,
            answer: evidence.answer,
          })
        : null;
    const { outcome, missingApps } = scoreEval(q, {
      answer: evidence.answer,
      error: failure,
      appsUsed:
        evidence.appAttribution === "withheld" ? null : evidence.appsUsed,
      judged: judged?.ok ? judged.judgement.passed : null,
    });
    return {
      ...result,
      outcome,
      answer: evidence.answer,
      missingApps,
      error: failure,
      judgement: judged?.ok ? judged.judgement : null,
      judgeError: judged && !judged.ok ? judged.error : null,
    };
  } catch (err) {
    if (err instanceof UnsettledTurnError) throw err;
    log.warn({ err, questionId: q.id }, "eval question failed");
    // The turn may still be going: stop it before the next question.
    if (result.turnId) {
      await abortTurn(ctx.workspaceId, result.turnId, ctx.userId).catch(
        (abortErr: unknown) =>
          log.warn(
            { err: abortErr, turnId: result.turnId },
            "could not stop an eval turn after a failure",
          ),
      );
      if (!(await waitForTurn(result.turnId, ABORT_SETTLE_MS)))
        throw new UnsettledTurnError(messageOf(err));
    }
    return scoreAsError(messageOf(err));
  }
};

/** Ask every question in order, checkpointing as it goes. Every write is
 * guarded on the run still being active, so a run that recovery already
 * ended is never written back to life. */
const executeRun = async (
  ctx: RunContext,
  runId: string,
  questions: EvalQuestion[],
) => {
  const results: EvalResult[] = [];
  const save = async (data: Prisma.AgentEvalRunUpdateManyMutationInput) => {
    const { count } = await db.agentEvalRun.updateMany({
      where: { id: runId, status: { in: [...ACTIVE_EVAL_RUN_STATUSES] } },
      data,
    });
    if (count === 0) throw new RunError("The run was ended before it finished");
  };
  try {
    await save({ status: "running", startedAt: new Date() });
    for (const q of questions) {
      const index = results.length;
      const result = await askQuestion(ctx, q, async (checkpoint) => {
        results[index] = checkpoint;
        await save({ results });
      });
      results[index] = result;
      await save({ results });
    }
    await save({ status: "done", finishedAt: new Date() });
  } catch (err) {
    log.error({ err, runId }, "eval run failed");
    await save({
      status: "failed",
      finishedAt: new Date(),
      error: messageOf(err),
      results,
    }).catch((saveErr: unknown) =>
      log.error({ err: saveErr, runId }, "could not record a failed eval run"),
    );
  }
};
