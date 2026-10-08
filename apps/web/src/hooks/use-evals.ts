"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isActiveEvalRun } from "@onecli/api/validations/evals";
import type { EvalQuestionInput } from "@onecli/api/validations/evals";
import { evals, type EvalRunDetail } from "@/lib/api";
import { queryKeys } from "@/lib/api/keys";

/** How often an active run is polled while it works. */
const ACTIVE_RUN_POLL_MS = 2_000;

/** The questions and the run history (summaries only). */
export const useEvals = (agentId: string) =>
  useQuery({
    queryKey: queryKeys.evals.agent(agentId),
    queryFn: () => evals.view(agentId),
  });

/**
 * One run in full. Polls only while the run is active; when a poll sees it
 * settle, the history list is refreshed once so its counts catch up.
 * Opening a run that had already finished refreshes nothing.
 */
export const useEvalRun = (agentId: string, runId: string | null) => {
  const qc = useQueryClient();
  const queryKey = queryKeys.evals.run(agentId, runId ?? "none");
  return useQuery({
    queryKey,
    queryFn: async () => {
      if (runId === null) throw new Error("A run ID is required");
      const before = qc.getQueryData<EvalRunDetail>(queryKey);
      const run = await evals.getRun(agentId, runId);
      if (
        before &&
        isActiveEvalRun(before.status) &&
        !isActiveEvalRun(run.status)
      )
        void qc.invalidateQueries({ queryKey: queryKeys.evals.agent(agentId) });
      return run;
    },
    enabled: runId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && isActiveEvalRun(status) ? ACTIVE_RUN_POLL_MS : false;
    },
  });
};

const useInvalidateEvals = (agentId: string) => {
  const qc = useQueryClient();
  return () =>
    qc.invalidateQueries({ queryKey: queryKeys.evals.agent(agentId) });
};

export const useSaveEvalQuestion = (agentId: string) => {
  const invalidate = useInvalidateEvals(agentId);
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string | null;
      input: EvalQuestionInput;
    }) =>
      id
        ? evals.updateQuestion(agentId, id, input)
        : evals.addQuestion(agentId, input),
    onSuccess: invalidate,
  });
};

export const useArchiveEvalQuestion = (agentId: string) => {
  const invalidate = useInvalidateEvals(agentId);
  return useMutation({
    mutationFn: (questionId: string) =>
      evals.archiveQuestion(agentId, questionId),
    onSuccess: invalidate,
  });
};

export const useStartEvalRun = (agentId: string) => {
  const invalidate = useInvalidateEvals(agentId);
  return useMutation({
    mutationFn: () => evals.startRun(agentId),
    onSuccess: invalidate,
  });
};
