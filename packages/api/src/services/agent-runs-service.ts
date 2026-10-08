import { db, Prisma } from "@onecli/db";
import { CHANNEL_PROVIDER_IDS } from "@onecli/channels";
import {
  textEventSchema,
  toolFinishedEventSchema,
  toolStartedEventSchema,
} from "@onecli/agent-protocol";
import { z } from "zod";
import { ServiceError } from "./errors";
import { isLlmHost } from "../lib/path-match";
import { CAPS } from "../lib/env";
import { getRoleResolver } from "../providers";
import { EVAL_SOURCE } from "../validations/conversation";
import {
  EVAL_HOST_PREFIX,
  isConcreteHost,
  normalizeLoggedHost,
} from "../validations/evals";
import {
  RUN_WINDOW_SLACK_MS,
  RUNS_PAGE_MAX,
  type RunAppAttribution,
  type RunAppCall,
  type RunDetail,
  type RunListItem,
  type RunsPage,
  type RunsQuery,
  type RunToolCall,
} from "../validations/runs";

/**
 * Agent RUNS: the turn audit view.
 *
 * One row per turn: who asked what, where from, what the agent answered, the
 * tools it called (with their arguments), and the gateway app evidence.
 * "Apps used" is read from the gateway's request_logs, never from tool
 * names: every app and custom-app credential is injected there, so an MCP
 * tool, a `bash` + `curl` or a script all land as the same row. A turn is
 * matched to gateway rows by agent and the turn's [start, finish] window,
 * which is approximate and can include other conversations, so that
 * evidence goes only to org admins and never carries request paths.
 *
 * VISIBILITY. A member sees their own runs plus non-direct ones (cron,
 * watch, eval, channel threads): the same fence as conversations. Where
 * roles are enforced (cloud, licensed self-host) an org admin also sees
 * everyone's DIRECT runs. A list names such a run but never carries its
 * content: opening it is the read, and the route audits each one. Without
 * role enforcement every member is an implicit admin, so that override does
 * not exist there: direct threads stay private to their owner.
 */

/** Characters of any one string the list returns: the list is a scan, the
 * detail is where full text lives. */
const LIST_TEXT_MAX = 300;

/** Gateway rows one evidence scan reads. One more than this means the scan
 * was partial, and partial evidence is withheld rather than scored. */
const EVIDENCE_SCAN_MAX = 5_000;

/** The gateway's LLM provider labels (mirrors telemetry's is_llm_provider). */
const LLM_PROVIDER_LABELS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "deepseek",
  "groq",
  "openrouter",
]);

/** The model's own traffic is not an app the agent used. */
const isModelTraffic = (log: { provider: string; host: string }) =>
  LLM_PROVIDER_LABELS.has(log.provider) || isLlmHost(log.host.toLowerCase());

const clip = (s: string, max = LIST_TEXT_MAX) =>
  s.length <= max ? s : `${s.slice(0, max)}…`;

const cursorSchema = z.tuple([z.iso.datetime(), z.string().min(1).max(100)]);

const beforeWhere = (before?: string): Prisma.TurnWhereInput => {
  if (!before) return {};
  const parsed = cursorSchema.safeParse(before.split("~"));
  if (!parsed.success)
    throw new ServiceError("UNPROCESSABLE", "Invalid Runs cursor");
  const [createdAt, id] = parsed.data;
  const at = new Date(createdAt);
  return {
    OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: id } }],
  };
};

/**
 * Whether this viewer holds the org-admin override on private runs. Only
 * where roles are enforced: the role resolver reads the membership row, so a
 * suspended admin or a member of another org gets nothing.
 */
const holdsAdminOverride = async (
  viewerUserId: string,
  organizationId: string,
): Promise<boolean> => {
  if (!CAPS.rbac) return false;
  const role = await getRoleResolver()?.getUserRole(
    viewerUserId,
    organizationId,
  );
  return role === "admin" || role === "owner";
};

/** The conversations a viewer may read runs from. */
const visibleConversations = (
  viewerUserId: string,
  isAdmin: boolean,
): Prisma.ConversationWhereInput => ({
  AND: [
    // Guest DMs are sourced (direct=false). Exclude them until Runs has a
    // guest-specific read policy, including for administrators.
    { OR: [{ direct: true }, { threadLink: { isNot: { kind: "direct" } } }] },
    // Detaching a channel deletes its links, not its conversation. A sourced
    // channel thread without a known group link fails closed.
    {
      OR: [
        { direct: true },
        { source: { notIn: [...CHANNEL_PROVIDER_IDS] } },
        { threadLink: { is: { kind: "group" } } },
      ],
    },
    ...(isAdmin ? [] : [{ OR: [{ direct: false }, { userId: viewerUserId }] }]),
  ],
});

const requireAgent = async (
  workspaceId: string,
  organizationId: string,
  agentId: string,
) => {
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId, workspace: { organizationId } },
    select: { id: true },
  });
  if (!agent) throw new ServiceError("NOT_FOUND", "Agent not found");
};

const turnSelect = {
  id: true,
  conversationId: true,
  source: true,
  status: true,
  message: true,
  error: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  conversation: {
    select: {
      direct: true,
      userId: true,
      agent: { select: { id: true, name: true } },
    },
  },
  user: { select: { id: true, email: true, name: true } },
} satisfies Prisma.TurnSelect;
type TurnRow = Prisma.TurnGetPayload<{ select: typeof turnSelect }>;

interface TurnEvidence {
  answer: string | null;
  tools: RunToolCall[];
}

const RUN_EVENT_TYPES = ["text", "tool.started", "tool.finished"];

/**
 * The turn's text answer and tool calls from its durable events. Payloads
 * are parsed with the protocol's own schemas; a row that does not parse
 * (an older or foreign shape) is skipped, never guessed at.
 */
const loadEvents = async (turnIds: string[]) => {
  const byTurn = new Map<string, TurnEvidence>();
  if (turnIds.length === 0) return byTurn;
  const events = await db.turnEvent.findMany({
    where: { turnId: { in: turnIds }, type: { in: RUN_EVENT_TYPES } },
    select: { turnId: true, payload: true },
    orderBy: { seq: "asc" },
  });
  for (const { turnId, payload } of events) {
    const acc = byTurn.get(turnId) ?? { answer: null, tools: [] };
    byTurn.set(turnId, acc);
    const text = textEventSchema.safeParse(payload);
    if (text.success) {
      acc.answer = text.data.text;
      continue;
    }
    const started = toolStartedEventSchema.safeParse(payload);
    if (started.success) {
      acc.tools.push({
        callId: started.data.callId,
        name: started.data.name,
        input: null,
        output: null,
        isError: false,
      });
      continue;
    }
    const finished = toolFinishedEventSchema.safeParse(payload);
    if (!finished.success) continue;
    const { callId, name, input, output, isError } = finished.data;
    const call = acc.tools.find((t) => t.callId === callId);
    const result = {
      input: input ?? null,
      output,
      isError: isError === true,
    };
    if (call) Object.assign(call, result);
    else acc.tools.push({ callId, name, ...result });
  }
  return byTurn;
};

const windowOf = (t: TurnRow) => ({
  start: (t.startedAt ?? t.createdAt).getTime() - RUN_WINDOW_SLACK_MS,
  end: t.finishedAt ? t.finishedAt.getTime() + RUN_WINDOW_SLACK_MS : Date.now(),
});

/**
 * App calls each turn's agent made during that turn, from the gateway log,
 * in ONE scan however many agents the turns span: each turn's window is
 * matched against its own agent's rows only. Model traffic is dropped.
 * Withheld when the scan would be partial.
 */
const loadAppCalls = async (
  workspaceId: string,
  turns: TurnRow[],
): Promise<{ calls: Map<string, RunAppCall[]>; withheld: boolean }> => {
  const calls = new Map<string, RunAppCall[]>();
  if (turns.length === 0) return { calls, withheld: false };
  const windows = turns.map((t) => ({
    id: t.id,
    agentId: t.conversation.agent.id,
    ...windowOf(t),
  }));
  const logs = await db.requestLog.findMany({
    where: {
      workspaceId,
      agentId: { in: [...new Set(windows.map((w) => w.agentId))] },
      createdAt: {
        gte: new Date(Math.min(...windows.map((w) => w.start))),
        lte: new Date(Math.max(...windows.map((w) => w.end))),
      },
    },
    // Paths may carry private text from unrelated overlapping turns.
    select: {
      agentId: true,
      provider: true,
      host: true,
      method: true,
      status: true,
      latencyMs: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
    take: EVIDENCE_SCAN_MAX + 1,
  });
  if (logs.length > EVIDENCE_SCAN_MAX) return { calls, withheld: true };
  for (const w of windows) calls.set(w.id, []);
  for (const log of logs) {
    if (isModelTraffic(log)) continue;
    const at = log.createdAt.getTime();
    for (const w of windows) {
      if (w.agentId !== log.agentId || at < w.start || at > w.end) continue;
      calls.get(w.id)?.push({
        provider: log.provider,
        host: log.host,
        method: log.method,
        status: log.status,
        latencyMs: log.latencyMs,
        at: log.createdAt.toISOString(),
      });
    }
  }
  return { calls, withheld: false };
};

const NO_APP_EVIDENCE = {
  calls: new Map<string, RunAppCall[]>(),
  withheld: true,
};

const summarize = (
  t: TurnRow,
  events: TurnEvidence | undefined,
  apps: RunAppCall[],
  attribution: RunAppAttribution,
): Omit<RunDetail, "tools" | "appCalls"> => ({
  turnId: t.id,
  conversationId: t.conversationId,
  agent: t.conversation.agent,
  source: t.source,
  direct: t.conversation.direct,
  status: t.status,
  question: t.message,
  answer: events?.answer ?? null,
  error: t.error,
  askedBy: t.user,
  toolNames: [...new Set((events?.tools ?? []).map((x) => x.name))],
  appAttribution: attribution,
  appsUsed: [...new Set(apps.map((a) => a.provider))],
  createdAt: t.createdAt.toISOString(),
  startedAt: t.startedAt?.toISOString() ?? null,
  finishedAt: t.finishedAt?.toISOString() ?? null,
  durationMs:
    t.startedAt && t.finishedAt
      ? t.finishedAt.getTime() - t.startedAt.getTime()
      : null,
});

/** A colleague's private thread: reading it is an audited admin override. */
const isOthersDirect = (t: TurnRow, viewerUserId: string) =>
  t.conversation.direct && t.conversation.userId !== viewerUserId;

/**
 * A run as a list row. A colleague's private thread keeps only its facts:
 * the question, the answer, the error and the tool names are content, and
 * content is read through the audited detail, never by listing or polling.
 */
const toListItem = (
  run: Omit<RunDetail, "tools" | "appCalls">,
  othersDirect: boolean,
): RunListItem => {
  const { question, answer, error, toolNames, ...facts } = run;
  if (othersDirect) return { ...facts, private: true };
  return {
    ...facts,
    private: false,
    question: clip(question),
    answer: answer === null ? null : clip(answer),
    error,
    toolNames,
  };
};

/**
 * One page of runs, newest first: one agent's, or the whole workspace's when
 * `agentId` is null (Activity). Lists never carry a colleague's private
 * content (see `toListItem`), so no list read is an audited one.
 */
export const listRuns = async (
  workspaceId: string,
  organizationId: string,
  viewerUserId: string,
  agentId: string | null,
  query: RunsQuery = {},
): Promise<RunsPage> => {
  if (agentId !== null)
    await requireAgent(workspaceId, organizationId, agentId);
  const isAdmin = await holdsAdminOverride(viewerUserId, organizationId);
  const limit = Math.min(Math.max(query.limit ?? 50, 1), RUNS_PAGE_MAX);
  // An app filter applies after the gateway join, so scan a full page.
  const scan = query.app ? RUNS_PAGE_MAX : limit;

  const turns = await db.turn.findMany({
    where: {
      conversation: {
        ...(agentId !== null && { agentId }),
        // The workspace fence holds with or without an agent: a run of
        // another workspace's agent is never in this list.
        agent: { workspaceId, workspace: { organizationId } },
        ...visibleConversations(viewerUserId, isAdmin),
      },
      status: query.failedOnly
        ? { in: ["failed", "aborted"] }
        : { notIn: ["joining", "joined"] },
      ...(query.source && { source: query.source }),
      ...(query.userId && { userId: query.userId }),
      ...beforeWhere(query.before),
    },
    select: turnSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: scan + 1,
  });

  const page = turns.slice(0, scan);
  // Time windows overlap private turns, so only admins get agent-wide
  // gateway evidence (provider and host metadata, and the app filter).
  const [events, apps] = await Promise.all([
    loadEvents(page.map((t) => t.id)),
    isAdmin ? loadAppCalls(workspaceId, page) : NO_APP_EVIDENCE,
  ]);
  const attribution: RunAppAttribution = apps.withheld
    ? "withheld"
    : "agent_time_window";
  const matched = page
    .map((t) => ({
      turn: t,
      run: summarize(
        t,
        events.get(t.id),
        apps.calls.get(t.id) ?? [],
        attribution,
      ),
    }))
    .filter(({ run }) => !query.app || run.appsUsed.includes(query.app));
  // With an app filter the page is every match in the scanned window and the
  // cursor is the last turn SCANNED, so paging never skips a turn.
  const shown = query.app ? matched : matched.slice(0, limit);
  const last = page.at(-1);
  return {
    runs: shown.map(({ turn, run }) =>
      toListItem(run, isOthersDirect(turn, viewerUserId)),
    ),
    nextBefore:
      turns.length > scan && last
        ? `${last.createdAt.toISOString()}~${last.id}`
        : null,
    isAdmin,
    appEvidenceWithheld: apps.withheld,
  };
};

export const getRun = async (
  workspaceId: string,
  organizationId: string,
  viewerUserId: string,
  agentId: string,
  turnId: string,
): Promise<{ run: RunDetail; viewedOthersDirect: boolean }> => {
  await requireAgent(workspaceId, organizationId, agentId);
  const isAdmin = await holdsAdminOverride(viewerUserId, organizationId);
  const turn = await db.turn.findFirst({
    where: {
      id: turnId,
      conversation: {
        agentId,
        agent: { workspaceId },
        ...visibleConversations(viewerUserId, isAdmin),
      },
    },
    select: turnSelect,
  });
  if (!turn) throw new ServiceError("NOT_FOUND", "Run not found");

  const [events, apps] = await Promise.all([
    loadEvents([turn.id]),
    isAdmin ? loadAppCalls(workspaceId, [turn]) : NO_APP_EVIDENCE,
  ]);
  const evidence = events.get(turn.id);
  const appCalls = apps.calls.get(turn.id) ?? [];
  return {
    run: {
      ...summarize(
        turn,
        evidence,
        appCalls,
        apps.withheld ? "withheld" : "agent_time_window",
      ),
      tools: evidence?.tools ?? [],
      appCalls,
    },
    viewedOthersDirect: isOthersDirect(turn, viewerUserId),
  };
};

/**
 * Evidence for scoring ONE eval question: its answer and the apps it
 * reached. Internal to the eval worker, not a dashboard read: it returns
 * only provider IDs plus the `host:` tokens the question itself asked
 * about, never request metadata. Any other turn of this agent overlapping
 * the window makes the evidence unavailable, and so does a partial scan.
 */
interface EvalTurnEvidence {
  answer: string | null;
  appsUsed: string[];
  appAttribution: RunAppAttribution;
}

export const getEvalRunEvidence = async (
  workspaceId: string,
  organizationId: string,
  askerUserId: string,
  agentId: string,
  turnId: string,
  expectedApps: readonly string[],
): Promise<EvalTurnEvidence> => {
  await requireAgent(workspaceId, organizationId, agentId);
  const turn = await db.turn.findFirst({
    where: {
      id: turnId,
      source: EVAL_SOURCE,
      userId: askerUserId,
      conversation: {
        agentId,
        agent: { workspaceId },
        source: EVAL_SOURCE,
        direct: false,
      },
    },
    select: turnSelect,
  });
  if (!turn) throw new ServiceError("NOT_FOUND", "Eval run not found");
  const window = windowOf(turn);
  const answer = (await loadEvents([turn.id])).get(turn.id)?.answer ?? null;
  const withheld = (): EvalTurnEvidence => ({
    answer,
    appsUsed: [],
    appAttribution: "withheld",
  });
  if (!turn.startedAt || !turn.finishedAt) return withheld();

  // Both windows carry the runner's slack, so widen by it once more.
  const overlap = await db.turn.findFirst({
    where: {
      id: { not: turn.id },
      conversation: { agentId, agent: { workspaceId } },
      AND: [
        {
          OR: [
            { startedAt: { lte: new Date(window.end + RUN_WINDOW_SLACK_MS) } },
            {
              startedAt: null,
              createdAt: { lte: new Date(window.end + RUN_WINDOW_SLACK_MS) },
            },
          ],
        },
        {
          OR: [
            { finishedAt: null },
            {
              finishedAt: { gte: new Date(window.start - RUN_WINDOW_SLACK_MS) },
            },
          ],
        },
      ],
    },
    select: { id: true },
  });
  if (overlap) return withheld();

  const logs = await db.requestLog.findMany({
    where: {
      workspaceId,
      agentId,
      createdAt: { gte: new Date(window.start), lte: new Date(window.end) },
    },
    select: { provider: true, host: true },
    take: EVIDENCE_SCAN_MAX + 1,
  });
  if (logs.length > EVIDENCE_SCAN_MAX) return withheld();

  const apps = logs.filter((log) => !isModelTraffic(log));
  const hosts = new Set(apps.map((app) => normalizeLoggedHost(app.host)));
  const matchedHosts = expectedApps.filter((app) => {
    if (!app.startsWith(EVAL_HOST_PREFIX)) return false;
    const host = app.slice(EVAL_HOST_PREFIX.length);
    return isConcreteHost(host) && hosts.has(host.toLowerCase());
  });
  return {
    answer,
    appsUsed: [...new Set([...apps.map((a) => a.provider), ...matchedHosts])],
    appAttribution: "agent_time_window",
  };
};
