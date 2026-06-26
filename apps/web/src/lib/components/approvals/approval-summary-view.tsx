import type { PendingApproval } from "@/lib/api/approvals";

const Field = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <div className="border-b border-border/50 py-2.5 last:border-b-0">
    <div className="text-muted-foreground text-xs">{label}</div>
    <div className="mt-1 text-sm break-words whitespace-pre-wrap">
      {children}
    </div>
  </div>
);

/**
 * Renders the gateway's structured approval summary (`{action, details}`) as a
 * stacked field list — label above the value, value left-aligned and full
 * width — so long fields like an email body read naturally. Falls back to the
 * flat `bodyPreview` when no structured summary is present. With `showMeta`
 * (default) it also appends method/host/path. Reused by the popover details
 * dialog and the Activity detail dialog.
 */
export const ApprovalSummaryView = ({
  approval,
  showMeta = true,
}: {
  approval: PendingApproval;
  showMeta?: boolean;
}) => {
  const details = approval.summary?.details ?? [];

  return (
    <div>
      {details.map((d, i) => (
        <Field key={`${d.label}-${i}`} label={d.label}>
          {d.value}
        </Field>
      ))}
      {details.length === 0 && approval.bodyPreview && (
        <pre className="bg-muted my-2 overflow-x-auto rounded-md p-3 text-xs whitespace-pre-wrap">
          {approval.bodyPreview}
        </pre>
      )}
      {showMeta && (
        <>
          <Field label="Method">
            <span className="font-mono text-xs">{approval.method}</span>
          </Field>
          <Field label="Host">
            <span className="font-medium">{approval.host}</span>
          </Field>
          <Field label="Path">
            <span className="font-mono text-xs">{approval.path || "/"}</span>
          </Field>
        </>
      )}
    </div>
  );
};
