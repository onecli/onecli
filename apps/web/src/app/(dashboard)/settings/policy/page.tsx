import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { PolicyMode } from "@onecli/api/validations/policy-rule";
import { PageHeader } from "@dashboard/page-header";
import { getPolicyMode } from "@/lib/actions/policy-mode";
import { POLICY_EDITING_ENABLED } from "@/lib/env";
import { PolicyModeToggle } from "./_components/policy-mode-toggle";

export const metadata: Metadata = {
  title: "Policy",
};

export default async function PolicyPage() {
  // Post-cutover (v2 editing live) the legacy policyMode toggle is retired —
  // the default posture lives on the Policy console's Default Rule and the v2
  // engine ignores `policyMode`, so this control would silently do nothing.
  // Flag-off (OSS / pre-cutover) renders unchanged.
  if (POLICY_EDITING_ENABLED) redirect("/policy");

  const policyMode = await getPolicyMode();

  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title="Default Policy"
        description="Control how traffic is handled when no rules match."
      />
      <PolicyModeToggle policyMode={policyMode as PolicyMode} />
    </div>
  );
}
