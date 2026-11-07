"use client";
// Editable policy engine (policy_rules_v2). Every write is enforced the moment
// it returns: the server publishes inside the write's transaction and its
// withAudit wrapper flushes the gateway, so there is nothing to apply here.
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { policy, type PageScope, type PolicyRuleV2 } from "@/lib/api";
import type {
  CreatePolicyRuleInput,
  UpdatePolicyRuleInput,
} from "@/lib/api/policy";
import { queryKeys } from "@/lib/api/keys";
import {
  installItem,
  listItem,
  patchItem,
  wholeValue,
} from "@/lib/api/optimistic";
import { useOptimisticMutation } from "@/hooks/use-optimistic-mutation";

/** The scope's rules (excludes the terminal Default Rule). */
export const usePolicyRules = (scope: PageScope = "workspace") =>
  useQuery({
    queryKey: queryKeys.policy.rules(scope),
    queryFn: () => policy.listRules(scope),
  });

export const usePolicyDefault = (scope: PageScope = "workspace") =>
  useQuery({
    queryKey: queryKeys.policy.default(scope),
    queryFn: () => policy.getDefault(scope),
  });

const invalidatePolicyViews = (qc: QueryClient) =>
  Promise.all([
    qc.invalidateQueries({ queryKey: queryKeys.policy.all() }),
    // The reflections READ these rules but are keyed by the resource they
    // describe, so a policy write has to reach them too — otherwise the
    // agent's Connections section and the agent-access dialog keep serving
    // pre-write verdicts for the query's stale window. They are the only
    // surfaces showing effective access, so a stale verdict there reads as a
    // security answer.
    qc.invalidateQueries({ queryKey: queryKeys.agents.all() }),
    qc.invalidateQueries({ queryKey: queryKeys.connections.all() }),
  ]);

const useInvalidatePolicy = () => {
  const qc = useQueryClient();
  return () => invalidatePolicyViews(qc);
};

export const useCreatePolicyRule = (scope: PageScope = "workspace") => {
  const invalidate = useInvalidatePolicy();
  return useMutation({
    mutationFn: (input: CreatePolicyRuleInput) =>
      policy.createRule(input, scope),
    onSuccess: () => invalidate(),
    onError: (err: Error) => toast.error(err.message),
  });
};

export const useUpdatePolicyRule = (scope: PageScope = "workspace") => {
  const invalidate = useInvalidatePolicy();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdatePolicyRuleInput }) =>
      policy.updateRule(id, input, scope),
    // Returned: the rule form's Saving… lasts until the table shows the
    // saved rule, so it never closes onto the old one.
    onSuccess: () => invalidate(),
    onError: (err: Error) => toast.error(err.message),
  });
};

const ruleRow = (id: string) => listItem<PolicyRuleV2>((r) => r.id === id);

/**
 * Enable / disable a rule from its row menu, instantly: the row un-mutes
 * (or mutes) on click, and a failure puts it back. Enforcement is the
 * server's: the write publishes atomically, and the effective-access views
 * refresh once it settles.
 */
export const useSetPolicyRuleEnabled = (scope: PageScope = "workspace") =>
  useOptimisticMutation<PolicyRuleV2, { id: string; enabled: boolean }>({
    family: `policy:${scope}`,
    itemKey: ({ id }) => `policy-rule:${id}`,
    write: ({ id, enabled }) => policy.updateRule(id, { enabled }, scope),
    apply: (qc, { id, enabled }) =>
      patchItem(qc, queryKeys.policy.rules(scope), ruleRow(id), (r) =>
        r ? { ...r, enabled } : r,
      ),
    confirm: (qc, rule, { id }) =>
      installItem(qc, queryKeys.policy.rules(scope), ruleRow(id), rule),
    refresh: invalidatePolicyViews,
    failure: (qc, { id, enabled }) => {
      const name = qc
        .getQueryData<PolicyRuleV2[]>(queryKeys.policy.rules(scope))
        ?.find((r) => r.id === id)?.name;
      return `Couldn't ${enabled ? "enable" : "disable"} ${name ? `"${name}"` : "the rule"}`;
    },
  });

export const useDeletePolicyRule = (scope: PageScope = "workspace") => {
  const invalidate = useInvalidatePolicy();
  return useMutation({
    mutationFn: (id: string) => policy.removeRule(id, scope),
    onSuccess: () => {
      invalidate();
      toast.success("Rule deleted");
    },
    onError: (err: Error) => toast.error(err.message),
  });
};

/**
 * Reorder the rules (drag-and-drop / Move up-down). Optimistic: the dropped
 * order lands in the cache immediately (no flash-back while the PUT is in
 * flight), rolls back on error, and settles on the server's list. Takes the
 * FULL ordered id list — build it with `buildReorderIds`.
 */
export const useReorderPolicyRules = (scope: PageScope = "workspace") => {
  const qc = useQueryClient();
  const invalidate = useInvalidatePolicy();
  const rulesKey = queryKeys.policy.rules(scope);
  return useMutation({
    mutationFn: (orderedIds: string[]) =>
      policy.reorderRules(orderedIds, scope),
    onMutate: async (orderedIds) => {
      await qc.cancelQueries({ queryKey: rulesKey });
      const previous = qc.getQueryData<PolicyRuleV2[]>(rulesKey);
      qc.setQueryData<PolicyRuleV2[]>(rulesKey, (old) => {
        if (!old) return old;
        const byId = new Map(old.map((r) => [r.id, r]));
        // Stamp the same 1-based priorities the server will write, so the
        // row numbers update immediately, not one round-trip later.
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
    // The route returns the fresh list — install it as truth right away.
    onSuccess: (rules) => qc.setQueryData(rulesKey, rules),
    onSettled: () => invalidate(),
  });
};

/** The Default Rule's Allowed / Blocked choice, instantly. */
export const useSetPolicyDefault = (scope: PageScope = "workspace") =>
  useOptimisticMutation<PolicyRuleV2, "allow" | "block">({
    family: `policy:${scope}`,
    itemKey: () => `policy-default:${scope}`,
    write: (action) => policy.setDefault(action, scope),
    apply: (qc, action) =>
      patchItem(
        qc,
        queryKeys.policy.default(scope),
        wholeValue<PolicyRuleV2>(),
        (rule) => (rule ? { ...rule, action } : rule),
      ),
    confirm: (qc, rule) =>
      installItem(
        qc,
        queryKeys.policy.default(scope),
        wholeValue<PolicyRuleV2>(),
        rule,
      ),
    refresh: invalidatePolicyViews,
    failure: (_qc, action) =>
      `Couldn't set the default to ${action === "allow" ? "Allowed" : "Blocked"}`,
  });
