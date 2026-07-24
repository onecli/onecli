import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { PolicyMode } from "@onecli/api/validations/policy-rule";
import { PageHeader } from "@dashboard/page-header";
import { getPolicyMode } from "@/lib/actions/policy-mode";
import { POLICY_EDITING_ENABLED } from "@/lib/env";
import { RulesContent } from "./_components/rules-content";

export const metadata: Metadata = {
  title: "Rules",
};

export default async function RulesPage() {
  // Post-cutover (v2 editing live) the legacy Rules page is retired: its
  // app-permission form writes the frozen old model (the API now 410s), and
  // rules are managed in the Policy console. Home routes to the right place
  // per edition; flag-off (OSS / pre-cutover) renders unchanged.
  if (POLICY_EDITING_ENABLED) redirect("/policy");

  const policyMode = await getPolicyMode();

  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Rules"
        description="Control what your agents can and cannot access."
      />
      <Suspense>
        <RulesContent
          policyMode={policyMode as PolicyMode}
          settingsHref="/settings/policy"
        />
      </Suspense>
    </div>
  );
}
