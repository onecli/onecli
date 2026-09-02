import { PageHeader } from "@dashboard/page-header";
import { getAuditLogs } from "./actions";
import { AuditLogsTable } from "./_components/audit-logs-table";

export default async function AuditLogsPage() {
  const logs = await getAuditLogs();

  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title="Audit Logs"
        description="Recent account activity and security events."
      />
      <AuditLogsTable logs={logs} />
    </div>
  );
}
