"use client";

import type { ProjectionIdentity } from "@/lib/api";

/**
 * The OSS identity-picker seam (step 9.5). OSS rules target a specific agent
 * or all agents (the plain Select in the rule form); directory identities —
 * agent-groups, users, user-groups — are a OneCLI Cloud capability. The org
 * picker can never render here (OSS mounts no org scope), and the hint under
 * the agent select says where the capability lives. The EE editions alias this
 * file to `@/ee/policy-editor/identity-picker`.
 */

export interface OrgIdentityPickerProps {
  value: ProjectionIdentity[];
  onChange: (next: ProjectionIdentity[]) => void;
  /** Id for the trigger, so a field <Label htmlFor> associates with the picker. */
  id?: string;
}

export const OrgIdentityPicker: (props: OrgIdentityPickerProps) => null = () =>
  null;

/** The locked capability hint under the project agent select. */
export const IdentityLockHint = () => (
  <p className="text-muted-foreground text-xs">
    Group and people identities are available on OneCLI Cloud.
  </p>
);
