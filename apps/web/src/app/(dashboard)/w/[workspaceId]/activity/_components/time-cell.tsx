import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { formatRelative, formatUTC } from "@onecli/api/lib/format";

const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** When a row happened, relative, with the exact UTC and local time on
 *  hover. Shared by Activity's Network and Runs tables. */
export const TimeCell = ({ iso }: { iso: string }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <time
        dateTime={iso}
        className="text-muted-foreground cursor-default text-xs tabular-nums"
      >
        {formatRelative(iso)}
      </time>
    </TooltipTrigger>
    <TooltipContent side="bottom" align="start" className="text-xs">
      <p>{formatUTC(iso)}</p>
      <p className="text-muted-foreground">
        {new Date(iso).toLocaleString()} ({localTz})
      </p>
    </TooltipContent>
  </Tooltip>
);
