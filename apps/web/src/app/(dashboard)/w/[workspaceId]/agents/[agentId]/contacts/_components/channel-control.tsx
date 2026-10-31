"use client";

import type { ChannelProvider, ChannelSpaceReach } from "@/lib/api";
import { useSetReachState } from "@/hooks/use-channels";
import {
  TriStateControl,
  type ToolChoice,
} from "../../_components/tri-state-control";
import { WaitingForApprovalBadge } from "./waiting-for-approval-badge";

/** A channel has ONE setting, two answers: the app-permission icons. */
const OPTIONS = ["allow", "never"] as const;

export interface ChannelControlProps {
  agentId: string;
  agentName: string;
  subject: string;
  reach: { provider: ChannelProvider; value: ChannelSpaceReach };
}

/**
 * A channel's ONE setting, the Direct messages and Agents pattern in the
 * app-permission icons: Always allow (the agent replies there and may post
 * there) or Never (neither). PENDING (an open ask) lives in the approvals
 * bell. What it replies to (Mentions / Every message) sits beside it while
 * allowed (`ChannelListenControl`).
 */
export const ChannelControl = ({
  agentId,
  agentName,
  subject,
  reach,
}: ChannelControlProps) => {
  const setReach = useSetReachState(agentId, reach.provider);
  const space = reach.value;
  if (space.state === "pending") return <WaitingForApprovalBadge />;
  const value: ToolChoice = space.state === "approved" ? "allow" : "never";

  return (
    <TriStateControl
      label={`Is ${agentName} on in ${subject}`}
      options={OPTIONS}
      value={value}
      onSelect={(choice) => {
        if (choice === value) return;
        // Instant: the icon moves on click; a failure puts it back and says
        // why. Never resets what it hears (server-side): allowed again, it
        // starts at Mentions.
        setReach.mutate({
          externalRef: space.externalRef,
          state: choice === "allow" ? "approved" : "blocked",
        });
      }}
    />
  );
};
