import { Badge } from "@onecli/ui/components/badge";

/** A run's state when it is not simply done: running, failed or stopped. */
export const RunStatusBadge = ({ status }: { status: string }) => {
  if (status === "done") return null;
  if (status === "failed" || status === "aborted")
    return (
      <Badge variant="destructive" className="shrink-0 text-[11px]">
        {status === "aborted" ? "Stopped" : "Failed"}
      </Badge>
    );
  return (
    <Badge variant="secondary" className="shrink-0 text-[11px]">
      Running
    </Badge>
  );
};
