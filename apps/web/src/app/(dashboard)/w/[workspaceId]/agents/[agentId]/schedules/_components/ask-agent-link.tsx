"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { agentChatDraftPath } from "@/lib/navigation";

/** Run conditions are written by the agent, never typed here: this opens
 * the agent's chat with a message ready to finish. */
export const AskAgentLink = ({
  agentId,
  label,
  draft,
}: {
  agentId: string;
  label: string;
  draft: string;
}) => {
  const pathname = usePathname();
  return (
    <Link
      href={agentChatDraftPath(pathname, agentId, draft)}
      className="text-foreground shrink-0 text-xs font-medium whitespace-nowrap underline-offset-4 hover:underline"
    >
      {label}
    </Link>
  );
};
