import { Suspense } from "react";
import type { Metadata } from "next";
import type { PolicyMode } from "@onecli/api/validations/policy-rule";
import { PageHeader } from "@dashboard/page-header";
import { getPolicyMode } from "@/lib/actions/policy-mode";
import { RulesContent } from "./_components/rules-content";

export const metadata: Metadata = {
  title: "Rules",
};

export default async function RulesPage() {
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
