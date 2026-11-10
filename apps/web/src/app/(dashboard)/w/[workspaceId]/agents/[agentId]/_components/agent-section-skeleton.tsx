import { Skeleton } from "@onecli/ui/components/skeleton";
import {
  isFullHeightAgentSection,
  isTheaterAgentSection,
} from "@/lib/agents/agent-sections";
import { SectionSkeleton } from "@/lib/dashboard/shell/section-skeleton";
import { ChatSkeleton } from "../chat/_components/chat-skeleton";

/**
 * An agent section while it loads, shaped like that section: the chat's
 * thread and composer for Chat, the theater's centred mark for the
 * full-page desktop, and a page of blocks for the rest. The content only:
 * the agent frame places it the way it places the section itself (the
 * scroll shell around an ordinary section, the raw cell for the others),
 * so the route's loading state and the frame's agent read draw one
 * picture in one place.
 */
export const AgentSectionSkeleton = ({ section }: { section: string }) => {
  if (isTheaterAgentSection(section)) {
    return (
      <div className="flex flex-1 items-center justify-center" aria-busy="true">
        <span className="sr-only">Loading agent</span>
        <Skeleton className="h-8 w-40" />
      </div>
    );
  }
  if (isFullHeightAgentSection(section)) return <ChatSkeleton />;
  return <SectionSkeleton />;
};
