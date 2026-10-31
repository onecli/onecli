"use client";

import type { ChannelPersonReach, ChannelProvider } from "@/lib/api";
import { useSetPersonReachState } from "@/hooks/use-channels";
import {
  TriStateControl,
  type ToolChoice,
} from "../../_components/tri-state-control";
import { WaitingForApprovalBadge } from "./waiting-for-approval-badge";

interface PersonControlProps {
  agentId: string;
  agentName: string;
  subject: string;
  reach: { provider: ChannelProvider; value: ChannelPersonReach };
}

/** A person has ONE setting, two answers: the app-permission icons. */
const OPTIONS = ["allow", "never"] as const;

/**
 * A person's one setting, in the app-permission icons: Always allow (they
 * can DM the agent, it answers and may message them) or Never (ignored, and
 * it won't message them). PENDING (their first DM is an open ask) lives in
 * the approvals bell. A workspace owner is a fixed Always allow: shown,
 * never changeable.
 */
export const PersonControl = ({
  agentId,
  agentName,
  subject,
  reach,
}: PersonControlProps) => {
  const setState = useSetPersonReachState(agentId, reach.provider);
  const person = reach.value;
  if (person.state === "pending") return <WaitingForApprovalBadge />;
  const value: ToolChoice = person.state === "approved" ? "allow" : "never";

  return (
    <TriStateControl
      label={`Can ${subject} and ${agentName} message each other`}
      options={OPTIONS}
      value={value}
      {...(person.isOwner && {
        isOptionDisabled: (option: ToolChoice) =>
          option === "never"
            ? {
                disabled: true,
                why: `A workspace owner can always DM ${agentName}`,
              }
            : { disabled: false },
      })}
      onSelect={(choice) => {
        if (person.isOwner || choice === value) return;
        // Instant: the icon moves on click; a failure puts it back and says
        // why.
        setState.mutate({
          externalRef: person.externalRef,
          state: choice === "allow" ? "approved" : "blocked",
        });
      }}
    />
  );
};
