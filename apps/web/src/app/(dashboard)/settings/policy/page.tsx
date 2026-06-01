import type { Metadata } from "next";
import type { PolicyMode } from "@onecli/api/validations/policy-rule";
import { PageHeader } from "@dashboard/page-header";
import { getPolicyMode } from "@/lib/actions/policy-mode";
import { PolicyModeToggle } from "./_components/policy-mode-toggle";

export const metadata: Metadata = {
  title: "Policy",
};

export default async function PolicyPage() {
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
