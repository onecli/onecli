import type {
  CreatePolicyRuleInput,
  UpdatePolicyRuleInput,
} from "@onecli/api/validations/policy";
import { apiGet, apiPost, apiPatch, apiPut, apiDelete } from "./client";
import type { PageScope } from "./scope";
import type { LastPublish, PolicyRuleV2, PublishResult } from "./types";

export type { CreatePolicyRuleInput, UpdatePolicyRuleInput };

// The editable policy engine: /v1/policy (workspace) or /v1/org/policy (org).
const policyPath = (scope: PageScope, sub = "") =>
  scope === "organization" ? `/v1/org/policy${sub}` : `/v1/policy${sub}`;

/** The scope's editable draft rules (excludes the terminal Default Rule). */
export const listRules = (
  scope: PageScope = "workspace",
  status: "draft" | "published" = "draft",
) => apiGet<PolicyRuleV2[]>(policyPath(scope, `/rules?status=${status}`));

export const createRule = (
  input: CreatePolicyRuleInput,
  scope: PageScope = "workspace",
) => apiPost<PolicyRuleV2>(policyPath(scope, "/rules"), input);

export const updateRule = (
  id: string,
  input: UpdatePolicyRuleInput,
  scope: PageScope = "workspace",
) => apiPatch<PolicyRuleV2>(policyPath(scope, `/rules/${id}`), input);

export const removeRule = (id: string, scope: PageScope = "workspace") =>
  apiDelete(policyPath(scope, `/rules/${id}`));

/**
 * Atomically re-prioritize the draft. `orderedIds` is the FULL ordered id list
 * — every non-default draft rule exactly once (customs, derived, and hidden
 * equipment rows; see `buildReorderIds`). 409s when the set is stale. Returns
 * the fresh draft list.
 */
export const reorderRules = (
  orderedIds: string[],
  scope: PageScope = "workspace",
) => apiPut<PolicyRuleV2[]>(policyPath(scope, "/rules/order"), { orderedIds });

/** The scope's terminal Default Rule (a virtual default when none is persisted). */
export const getDefault = (
  scope: PageScope = "workspace",
  status: "draft" | "published" = "draft",
) => apiGet<PolicyRuleV2>(policyPath(scope, `/default?status=${status}`));

export const setDefault = (
  action: "allow" | "block",
  scope: PageScope = "workspace",
) => apiPatch<PolicyRuleV2>(policyPath(scope, "/default"), { action });

/** Snapshot the scope's draft set into a fresh published generation. */
export const publish = (scope: PageScope = "workspace") =>
  apiPost<PublishResult>(policyPath(scope, "/publish"), {});

/** Who last applied this scope's policy, and when — null when never published. */
export const lastPublish = (scope: PageScope = "workspace") =>
  apiGet<LastPublish | null>(policyPath(scope, "/last-publish"));
