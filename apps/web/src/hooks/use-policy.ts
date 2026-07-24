"use client";
// Editable policy engine (policy_rules_v2). Headless on the gateway cache: every
// mutation route is wrapped in withAudit, which flushes the gateway server-side —
// no client-side flush needed. Staged model: create/update/delete edit the DRAFT;
// `usePublishPolicy` snapshots the draft into the active published generation.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { policy, type PageScope, type PolicyRuleV2 } from "@/lib/api";
import type {
  CreatePolicyRuleInput,
  UpdatePolicyRuleInput,
} from "@/lib/api/policy";
import { queryKeys } from "@/lib/api/keys";
// Edition seam: OSS publishes immediately after every write (chained inside
// the mutation, so pending covers write + publish); EE aliases this to a no-op
// — its publish is the explicit staged Apply Changes flow.
import { afterPolicyWrite } from "@/lib/policy-editor/publish-mode";

/** The editable draft rules (excludes the terminal Default Rule). */
export const usePolicyRules = (scope: PageScope = "project") =>
  useQuery({
    queryKey: queryKeys.policy.rules(scope),
    queryFn: () => policy.listRules(scope, "draft"),
  });

/** The active published rules — compared against the draft to detect unpublished
 * changes (the "you have changes to publish" indicator). */
export const usePublishedPolicyRules = (scope: PageScope = "project") =>
  useQuery({
    queryKey: [...queryKeys.policy.rules(scope), "published"],
    queryFn: () => policy.listRules(scope, "published"),
  });

export const usePolicyDefault = (scope: PageScope = "project") =>
  useQuery({
    queryKey: queryKeys.policy.default(scope),
    queryFn: () => policy.getDefault(scope, "draft"),
  });

/** The published Default Rule — compared against the draft default to fold the
 * terminal rule into the "unpublished changes" indicator. */
export const usePublishedPolicyDefault = (scope: PageScope = "project") =>
  useQuery({
    queryKey: [...queryKeys.policy.default(scope), "published"],
    queryFn: () => policy.getDefault(scope, "published"),
  });

/** Who last applied this scope's policy, and when (null = never published). */
export const usePolicyLastPublish = (scope: PageScope = "project") =>
  useQuery({
    queryKey: queryKeys.policy.lastPublish(scope),
    queryFn: () => policy.lastPublish(scope),
  });

const useInvalidatePolicy = () => {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: queryKeys.policy.all() });
};

export const useCreatePolicyRule = (scope: PageScope = "project") => {
  const invalidate = useInvalidatePolicy();
  return useMutation({
    mutationFn: (input: CreatePolicyRuleInput) =>
      policy.createRule(input, scope).then(async (r) => {
        await afterPolicyWrite(scope);
        return r;
      }),
    onSuccess: () => invalidate(),
    onError: (err: Error) => toast.error(err.message),
  });
};

export const useUpdatePolicyRule = (scope: PageScope = "project") => {
  const invalidate = useInvalidatePolicy();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdatePolicyRuleInput }) =>
      policy.updateRule(id, input, scope).then(async (r) => {
        await afterPolicyWrite(scope);
        return r;
      }),
    onSuccess: () => invalidate(),
    onError: (err: Error) => toast.error(err.message),
  });
};

export const useDeletePolicyRule = (scope: PageScope = "project") => {
  const invalidate = useInvalidatePolicy();
  return useMutation({
    mutationFn: (id: string) =>
      policy.removeRule(id, scope).then(() => afterPolicyWrite(scope)),
    onSuccess: () => {
      invalidate();
      toast.success("Rule deleted");
    },
    onError: (err: Error) => toast.error(err.message),
  });
};

/**
 * Reorder the draft (drag-and-drop / Move up-down). Optimistic: the dropped
 * order lands in the cache immediately (no flash-back while the PUT is in
 * flight), rolls back on error, and settles on the server's list. Takes the
 * FULL ordered id list — build it with `buildReorderIds`.
 */
export const useReorderPolicyRules = (scope: PageScope = "project") => {
  const qc = useQueryClient();
  const rulesKey = queryKeys.policy.rules(scope);
  return useMutation({
    mutationFn: (orderedIds: string[]) =>
      policy.reorderRules(orderedIds, scope).then(async (r) => {
        await afterPolicyWrite(scope);
        return r;
      }),
    onMutate: async (orderedIds) => {
      await qc.cancelQueries({ queryKey: rulesKey });
      const previous = qc.getQueryData<PolicyRuleV2[]>(rulesKey);
      qc.setQueryData<PolicyRuleV2[]>(rulesKey, (old) => {
        if (!old) return old;
        const byId = new Map(old.map((r) => [r.id, r]));
        // Stamp the same 1-based priorities the server will write, so
        // priority-sorting consumers (the staged diff) see the new order
        // immediately, not one round-trip later.
        const next = orderedIds.flatMap((id, i) => {
          const rule = byId.get(id);
          return rule ? [{ ...rule, priority: i + 1 }] : [];
        });
        // A partial mapping means the cache and the drag diverged — leave the
        // cache alone and let the server's 409/response settle it.
        return next.length === old.length ? next : old;
      });
      return { previous };
    },
    onError: (err: Error, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(rulesKey, ctx.previous);
      toast.error(err.message);
    },
    // The route returns the fresh draft list — install it as truth right away.
    onSuccess: (rules) => qc.setQueryData(rulesKey, rules),
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.policy.all() }),
  });
};

export const useSetPolicyDefault = (scope: PageScope = "project") => {
  const invalidate = useInvalidatePolicy();
  return useMutation({
    mutationFn: (action: "allow" | "block") =>
      policy.setDefault(action, scope).then(async (r) => {
        await afterPolicyWrite(scope);
        return r;
      }),
    onSuccess: () => invalidate(),
    onError: (err: Error) => toast.error(err.message),
  });
};

export const usePublishPolicy = (scope: PageScope = "project") => {
  const invalidate = useInvalidatePolicy();
  return useMutation({
    mutationFn: () => policy.publish(scope),
    onSuccess: () => {
      invalidate();
      toast.success("Changes applied — now enforced");
    },
    onError: (err: Error) => toast.error(err.message),
  });
};
