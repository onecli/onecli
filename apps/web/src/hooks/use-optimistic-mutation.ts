"use client";

import {
  MutationObserver,
  useIsMutating,
  useMutation,
  useQueryClient,
  type QueryClient,
  type UseMutationOptions,
} from "@tanstack/react-query";
import {
  queuedWrites,
  serializeWrite,
  writeFamily,
  type Rollback,
} from "@/lib/api/optimistic";
import { writeErrorToast } from "@/lib/api/write-error-toast";

/**
 * One optimistic write, declared once: what it sends, how it shows on screen
 * before the server answers, and how it settles. See `lib/api/optimistic.ts`
 * for the model.
 */
export interface OptimisticWrite<TData, TVariables> {
  /** Related writes that refresh the truth once, after the last settles
   * ("grants", "crons"…). Also the mutation key, so a view can ask whether
   * its family is writing (to pause a poll, or to mark a row as settling). */
  family: string;
  /** The item a write targets. Writes to one item run in click order, and
   * a failure toast for it replaces the previous one. */
  itemKey: (variables: TVariables) => string;
  /** The request itself. */
  write: (variables: TVariables) => Promise<TData>;
  /** Show the write on screen now; return how to undo exactly that. Async
   * only when it must first load what it needs to show (rare). */
  apply: (
    qc: QueryClient,
    variables: TVariables,
  ) => Rollback | Promise<Rollback>;
  /** Install the server's answer. Skipped while a later write to the same
   * item is queued: that one's answer is the newer truth. */
  confirm?: (qc: QueryClient, data: TData, variables: TVariables) => void;
  /** Refetch everything the write family can make stale. Runs once per
   * burst, after its last write settles (success or failure). */
  refresh: (qc: QueryClient) => Promise<unknown>;
  /** The failure toast's title: what did NOT happen. */
  failure: (qc: QueryClient, variables: TVariables) => string;
  /** A side effect of success that must outlive the row that clicked: a
   * remove's confirmation ("Schedule deleted"), said once the server agrees,
   * since the row and its dialog are gone the moment it was clicked. */
  succeeded?: (data: TData, variables: TVariables) => void;
}

export const optimisticKey = (family: string) =>
  ["optimistic-write", family] as const;

/**
 * A mutation that answers the click at once: `apply` paints the result, the
 * request runs behind it in per-item click order, a failure puts back just
 * that item and says why (with Retry when it may help), and the family's
 * truth is refetched once its last write settles. The mutation stays
 * pending until that refetch lands, so `useWriteSettling` covers the whole
 * window in which reflections derived from the server are stale.
 *
 * Controls driven by it must NOT disable themselves while it is pending:
 * the next click is a new, queued write, never a conflict.
 */
export const useOptimisticMutation = <TData, TVariables>(
  spec: OptimisticWrite<TData, TVariables>,
) => {
  const qc = useQueryClient();
  const family = writeFamily(qc, spec.family);
  const options: UseMutationOptions<TData, Error, TVariables, Rollback> = {
    mutationKey: optimisticKey(spec.family),
    mutationFn: (variables) =>
      serializeWrite(spec.itemKey(variables), () => spec.write(variables)),
    onMutate: (variables) => {
      family.begin();
      return spec.apply(qc, variables);
    },
    onSuccess: (data, variables) => {
      if (queuedWrites(spec.itemKey(variables)) === 0) {
        spec.confirm?.(qc, data, variables);
      }
      spec.succeeded?.(data, variables);
    },
    onError: (error, variables, rollback) => {
      rollback?.();
      writeErrorToast(spec.failure(qc, variables), error, {
        id: spec.itemKey(variables),
        // A fresh observer: the clicking row may be gone by now (a remove).
        retry: () => {
          void new MutationObserver(qc, options)
            .mutate(variables)
            .catch(() => undefined);
        },
      });
    },
    onSettled: () => family.settle(() => spec.refresh(qc)),
  };
  return useMutation(options);
};

/**
 * Whether a write of `family` matching `matches` is still settling: sent,
 * or answered but its refetch not yet on screen. For hiding a reflection
 * the server computes (an effective-access pill) while it describes the
 * state before the click, rather than guessing its next value.
 */
export const useWriteSettling = (
  family: string,
  matches: (variables: unknown) => boolean,
): boolean =>
  useIsMutating({
    mutationKey: optimisticKey(family),
    predicate: (mutation) => matches(mutation.state.variables),
  }) > 0;

/** Whether any write of `family` is in flight: pause a poll while it is, or
 * the poll repaints the pre-click state over the click. */
export const useFamilyWriting = (family: string): boolean =>
  useIsMutating({ mutationKey: optimisticKey(family) }) > 0;
