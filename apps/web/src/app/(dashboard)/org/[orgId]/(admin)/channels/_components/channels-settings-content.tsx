import { PageHeader } from "@dashboard/page-header";
import { SlackCardsRow } from "./slack-cards-row";
import { SlackAgentsSection } from "./slack-agents-section";
import { ChannelUserLinksCard } from "./channel-user-links-card";

// Channels are a FREE surface (§3.16) — no entitlement gate, deliberately.
/** The Settings modal's Slack page body. */
export const ChannelsSettingsContent = () => (
  <div className="flex flex-1 flex-col gap-4">
    <PageHeader
      character="drop-list"
      title="Channels"
      description="Connect your chat workspaces so agents can join them."
    />
    {/* The Slack connection, then (once one-click is real) every agent a
        click away from Slack, then the rare people-matching escape hatch.
        Full width, like every card on the admin pages. */}
    <SlackCardsRow />
    <SlackAgentsSection />
    <ChannelUserLinksCard />
  </div>
);
