import type {
  EvalCheckKind,
  EvalOutcomeCounts,
  EvalQuestionInput,
  EvalResultView,
  EvalRunStatus,
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
  configVersion: string;
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

export interface EvalsView {
  questions: EvalQuestion[];
  runs: EvalRunSummary[];
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
