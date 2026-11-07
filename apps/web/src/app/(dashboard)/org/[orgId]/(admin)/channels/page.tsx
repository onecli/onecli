import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { SlackCardsRow } from "./_components/slack-cards-row";
import { SlackAgentsSection } from "./_components/slack-agents-section";
import { ChannelUserLinksCard } from "./_components/channel-user-links-card";

export const metadata: Metadata = {
  title: "Channels",
};

// Channels are a FREE surface (§3.16) — no entitlement gate, deliberately.
export default function ChannelsSettingsPage() {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
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
}
