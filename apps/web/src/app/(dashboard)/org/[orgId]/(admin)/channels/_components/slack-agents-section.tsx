"use client";

import { useOrgChannels } from "@/hooks/use-org-channels";
import { SlackAgentsCard } from "./slack-agents-card";

/**
 * Shows the one-click "Agents in Slack" list only once one-click is real:
 * the org's Slack automation credential is live (or the shared install can
 * create agent apps). Before that, the Slack card above is the only thing
 * to do, and a list of buttons that cannot work would be noise.
 */
export const SlackAgentsSection = () => {
  const { data } = useOrgChannels();
  const slack = data?.integrations.find((i) => i.provider === "slack");
  const canMint =
    Boolean(slack?.hasCredentials) ||
    Boolean(data?.sharedApp?.canMintAgentApps);
  if (!canMint) return null;
  return <SlackAgentsCard workspaceName={slack?.name ?? null} />;
};
