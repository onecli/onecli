import type {
  EvalCheckKind,
  EvalOutcomeCounts,
  EvalQuestionInput,
  EvalResultView,
  EvalRunStatus,
  EvalRunTrigger,
  EvalScheduleDisabledReason,
  EvalScheduleInput,
  EvalScheduleOutcome,
} from "@onecli/api/validations/evals";
import { apiDelete, apiGet, apiPost, apiPut } from "./client";

/**
 * The agent EVALS client: /v1/agents/:agentId/evals/...
 * Shapes mirror `agent-eval-service.ts`; dates as ISO strings. The result
 * and question contracts are imported from the shared validations module,
 * so the two sides cannot drift.
 */

export interface EvalQuestion {
  id: string;
  question: string;
  expected: string;
  kind: EvalCheckKind;
  expectedApps: string[];
}

export interface EvalRunSummary {
  id: string;
  status: EvalRunStatus;
  trigger: EvalRunTrigger;
  configVersion: string;
  /** The model the agent answered with; null on older runs. */
  model: string | null;
  total: number;
  counts: EvalOutcomeCounts;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface EvalRunDetail extends EvalRunSummary {
  results: EvalResultView[];
  previous: { id: string; configVersion: string } | null;
}

/** The agent's eval schedule (one per agent). */
export interface EvalSchedule {
  schedule: string;
  timezone: string;
  enabled: boolean;
  disabledReason: EvalScheduleDisabledReason | null;
  nextFireAt: string;
  lastFiredAt: string | null;
  lastOutcome: EvalScheduleOutcome | null;
}

export interface EvalsView {
  questions: EvalQuestion[];
  runs: EvalRunSummary[];
  schedule: EvalSchedule | null;
  maxQuestions: number;
}

const base = (agentId: string, sub = "") =>
  `/v1/agents/${encodeURIComponent(agentId)}/evals${sub}`;

const questionPath = (agentId: string, questionId: string) =>
  base(agentId, `/questions/${encodeURIComponent(questionId)}`);

export const view = (agentId: string) => apiGet<EvalsView>(base(agentId));

export const addQuestion = (agentId: string, input: EvalQuestionInput) =>
  apiPost<EvalQuestion>(base(agentId, "/questions"), input);

export const updateQuestion = (
  agentId: string,
  questionId: string,
  input: EvalQuestionInput,
) => apiPut<EvalQuestion>(questionPath(agentId, questionId), input);

export const archiveQuestion = (agentId: string, questionId: string) =>
  apiDelete(questionPath(agentId, questionId));

export const startRun = (agentId: string) =>
  apiPost<EvalRunSummary>(base(agentId, "/runs"), {});

export const getRun = (agentId: string, runId: string) =>
  apiGet<EvalRunDetail>(base(agentId, `/runs/${encodeURIComponent(runId)}`));

export const saveSchedule = (agentId: string, input: EvalScheduleInput) =>
  apiPut<EvalSchedule>(base(agentId, "/schedule"), input);

export const deleteSchedule = (agentId: string) =>
  apiDelete(base(agentId, "/schedule"));
