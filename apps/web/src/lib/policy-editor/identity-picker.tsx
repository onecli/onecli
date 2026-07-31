"use client";

import type { ProjectionIdentity } from "@/lib/api";

/**
 * The OSS identity-picker seam (step 9.5). Directory identities (users,
 * user-groups) are a OneCLI Cloud capability, and since attach-model step 6
 * the only policy console left is the ORG one — which OSS does not mount at
 * all. So this stub can never render; it exists to keep the shared rule form
 * compiling in an OSS build. The EE editions alias this file to
 * `@/ee/policy-editor/identity-picker`.
 */

export interface OrgIdentityPickerProps {
  value: ProjectionIdentity[];
  onChange: (next: ProjectionIdentity[]) => void;
  /** Id for the trigger, so a field <Label htmlFor> associates with the picker. */
  id?: string;
}

export const OrgIdentityPicker: (props: OrgIdentityPickerProps) => null = () =>
  null;
