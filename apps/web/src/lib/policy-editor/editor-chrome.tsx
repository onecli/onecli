"use client";

import type { PolicyDiff } from "@onecli/api/lib/policy-diff";
import type { PageScope, PolicyRuleV2 } from "@/lib/api";

/**
 * The OSS editor chrome (step 9.5) — deliberately empty. The staged publish
 * surface (Test a request, Apply Changes + review, last-applied), the org
 * guardrails, and directory name resolution are OneCLI Cloud capabilities;
 * OSS's editor is immediate-apply and project-scoped, so this module renders
 * nothing. The EE editions alias this file to `@/ee/policy-editor/editor-chrome`
 * (the real chrome).
 */

const NO_DIRECTORY = (): undefined => undefined;

export const useDirectoryNames = (): ((id: string) => string | undefined) =>
  NO_DIRECTORY;

export interface StagedActionsProps {
  scope: PageScope;
  policyDiff: PolicyDiff | null;
}

export const StagedActions: (props: StagedActionsProps) => null = () => null;

export const StagedMeta: (props: { scope: PageScope }) => null = () => null;

export interface OrgGuardrailsProps {
  query: string;
  identityName: (id: string) => string;
  onEdit: (rule: PolicyRuleV2) => void;
  onToggleEnabled: (rule: PolicyRuleV2) => void;
  onDelete: (rule: PolicyRuleV2) => void;
}

export const OrgGuardrails: (props: OrgGuardrailsProps) => null = () => null;

/** OSS has no organization level — the evaluation explainer describes the
 * single project list only. The EE arm exports `true`. */
export const ORG_GUARDRAILS_AVAILABLE = false;
