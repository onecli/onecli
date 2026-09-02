import { Skeleton } from "@onecli/ui/components/skeleton";

/** Shown inside the agent page frame, which supplies the section shell. */
export default function AgentSectionLoading() {
  return (
    <div className="space-y-3">
      {[1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}
