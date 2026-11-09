import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { PolicyEditor } from "@/lib/policy-editor";

export const metadata: Metadata = {
  title: "Global Policy",
};

// The org-wide guardrails console.
export default function OrgPolicyPage() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        character="cloud-wait"
        title="Global Policy"
        description="These guardrails apply to every workspace in your organization. The strictest matching rule decides each request."
      />
      <PolicyEditor scope="organization" />
    </div>
  );
}
