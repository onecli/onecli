import type { Metadata } from "next";
import { TriangleAlert } from "lucide-react";
import { PageHeader } from "@dashboard/page-header";
import { getApprovalPaths } from "@/lib/actions/approval-paths";
import { OneCliPathCard } from "./_components/onecli-path-card";
import { NtfyPathCard } from "./_components/ntfy-path-card";

export const metadata: Metadata = {
  title: "Approval Paths",
};

export default async function ApprovalPathsPage() {
  const paths = await getApprovalPaths();
  const onecli = paths["onecli"];
  const ntfy = paths["ntfy"];

  // "onecli" is default-on (absent row = enabled); ntfy is opt-in.
  const onecliEnabled = onecli?.enabled ?? true;
  const ntfyEnabled = ntfy?.enabled ?? false;
  const anyEnabled = onecliEnabled || ntfyEnabled;

  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title="Approval Paths"
        description="Choose how manual-approval requests are delivered for you to approve or deny. Enable any combination of channels."
      />

      {!anyEnabled && (
        <div className="border-destructive/40 bg-destructive/5 text-foreground flex items-start gap-2 rounded-lg border p-3 text-sm">
          <TriangleAlert className="text-destructive mt-0.5 size-4 shrink-0" />
          <p>
            No approval path is enabled. Any request that hits a{" "}
            <strong>manual approval</strong> rule will be held until it times
            out and is then <strong>denied</strong>. Enable at least one channel
            below.
          </p>
        </div>
      )}

      <OneCliPathCard
        enabled={onecliEnabled}
        settings={onecli?.settings ?? {}}
      />
      <NtfyPathCard
        enabled={ntfyEnabled}
        settings={ntfy?.settings ?? {}}
        hasCredentials={ntfy?.hasCredentials ?? false}
      />
    </div>
  );
}
