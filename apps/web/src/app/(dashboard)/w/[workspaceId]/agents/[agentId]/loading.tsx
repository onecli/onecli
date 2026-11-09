"use client";

import { usePathname } from "next/navigation";
import { matchAgentPage } from "@/lib/navigation";
import { AgentSectionSkeleton } from "./_components/agent-section-skeleton";

/**
 * The agent page while a section renders, inside the agent frame. Shaped
 * like the section being opened (the URL says which), so opening Chat
 * shows the chat's thread and composer from the first frame, never a
 * generic list that turns into one.
 */
export default function AgentSectionLoading() {
  const section = matchAgentPage(usePathname())?.section ?? "";
  return <AgentSectionSkeleton section={section} />;
}
