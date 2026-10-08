import { Badge } from "@onecli/ui/components/badge";

/** Where a run came from, in words. Unknown sources show as they are. */
const SOURCE_LABEL: Record<string, string> = {
  web: "Web",
  slack: "Slack",
  eval: "Test",
  cron: "Schedule",
  webhook: "Webhook",
  watch: "Watch",
  agent: "Agent",
  greeting: "Greeting",
  peer_task: "Peer task",
};

export const RunSourceBadge = ({ source }: { source: string }) => (
  <Badge variant="outline" className="text-[11px]">
    {SOURCE_LABEL[source] ?? source}
  </Badge>
);
