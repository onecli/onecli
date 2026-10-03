"use client";

import type { ApprovalGroup } from "@onecli/api/lib/approval-groups";
import type { PendingApproval } from "@/lib/api/approvals";
import { ApprovalAppIcon } from "@/lib/components/approvals/approval-app-icon";
import {
  GroupedApprovalCard,
  type SettledMember,
} from "@/lib/components/approvals/grouped-approval-card";

/**
 * Several live tasks raised at the same point in the thread (one agent
 * creating 2 contacts while updating 3) read as one card with a section per
 * task, never as a pile of look-alike cards. Each section keeps its own
 * Approve all: one click never mixes a create with an update.
 */
export const ApprovalGroupStack = ({
  groups,
}: {
  groups: {
    key: string;
    group: ApprovalGroup<PendingApproval>;
    settled: SettledMember[];
  }[];
}) => {
  const waiting = groups.reduce((n, g) => n + g.group.approvals.length, 0);
  const apps = new Set(groups.map((g) => g.group.approvals[0]?.app));
  return (
    <section
      aria-label={`${waiting} requests waiting for approval`}
      className="bg-muted/50 w-full overflow-hidden rounded-xl border"
    >
      <div className="bg-background/50 flex items-center gap-2.5 border-b px-4 py-2.5">
        {apps.size === 1 && <ApprovalAppIcon appId={[...apps][0]} />}
        <p className="text-sm font-semibold">
          {waiting} approvals · {groups.length} tasks
        </p>
      </div>
      <div className="divide-y">
        {groups.map((g) => (
          <GroupedApprovalCard
            key={g.key}
            group={g.group}
            settled={g.settled}
            section
          />
        ))}
      </div>
    </section>
  );
};
