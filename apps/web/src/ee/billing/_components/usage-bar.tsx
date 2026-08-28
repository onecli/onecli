export interface UsageBarProps {
  label: string;
  current: number;
  limit: number;
}

/** The amber `current/limit` usage card shown in the quota-limit dialog. */
export const UsageBar = ({ label, current, limit }: UsageBarProps) => (
  <div className="w-full space-y-2.5 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3">
    <div className="flex items-center justify-between">
      <span className="text-sm font-medium">{label}</span>
      <span className="tabular-nums text-sm font-medium text-amber-600 dark:text-amber-400">
        {current}/{limit}
      </span>
    </div>
    <div className="h-1.5 overflow-hidden rounded-full bg-amber-500/15">
      <div className="h-full w-full rounded-full bg-amber-500" />
    </div>
  </div>
);
