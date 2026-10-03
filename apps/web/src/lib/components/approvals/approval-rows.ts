import type {
  ApprovalDetail,
  ApprovalSummary,
  PendingApproval,
} from "@/lib/api/approvals";

/** The summary's rows minus the one its title already names: the subject's
 *  own record row (the gateway says which, by index). */
export const rowsBesideTitle = (
  summary: ApprovalSummary | null | undefined,
): ApprovalDetail[] =>
  (summary?.details ?? []).filter((_, i) => i !== summary?.subject?.row);

/** The row the title's record comes from. Its value always carries the
 *  record's id ("Dana Reyes (003…)", "Account · 001…"), so it tells two
 *  records apart even when their names match. */
export const subjectRow = (
  summary: ApprovalSummary | null | undefined,
): ApprovalDetail | undefined =>
  summary?.subject ? summary.details[summary.subject.row] : undefined;

/** Whether every request's title names the same record (three uploads to
 *  one Account), so a card can name it once. Compared by the record's row,
 *  never by its name alone. */
export const shareOneRecord = (
  approvals: readonly Pick<PendingApproval, "summary">[],
) => {
  const recordOf = ({ summary }: Pick<PendingApproval, "summary">) =>
    summary?.subject &&
    `${summary.action}\n${subjectRow(summary)?.value ?? ""}`;
  const [first, ...rest] = approvals.map(recordOf);
  return !!first && rest.every((r) => r === first);
};

/** Pick the rows a preview lays out by label (case-insensitive, first wins);
 *  every other row passes through in order, so nothing is hidden. The
 *  summarizers own the labels; a preview only chooses which to place. */
export const pickRows = (details: ApprovalDetail[], labels: string[]) => {
  const wanted = new Set(labels.map((l) => l.toLowerCase()));
  const picked = new Map<string, ApprovalDetail>();
  const rest: ApprovalDetail[] = [];
  for (const d of details) {
    const key = d.label.toLowerCase();
    if (wanted.has(key) && !picked.has(key)) picked.set(key, d);
    else rest.push(d);
  }
  return { get: (l: string) => picked.get(l.toLowerCase()), rest };
};
