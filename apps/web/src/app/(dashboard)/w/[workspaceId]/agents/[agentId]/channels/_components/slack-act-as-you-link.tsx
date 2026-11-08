"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { agentSectionPath } from "@/lib/navigation";

export interface SlackActAsYouLinkProps {
  agentId: string;
  agentName: string;
}

/** Points the Slack page at Contacts "acts as you", where the reading and
 * sending with people's own Slack is managed now. */
export const SlackActAsYouLink = ({
  agentId,
  agentName,
}: SlackActAsYouLinkProps) => {
  const pathname = usePathname();
  const href = agentSectionPath(pathname, agentId, "contacts");
  return (
    <Link
      href={href}
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline"
    >
      Manage what <span translate="no">{agentName}</span> reads and sends as you
      in Contacts
      <ArrowRight className="size-3.5" aria-hidden />
    </Link>
  );
};
