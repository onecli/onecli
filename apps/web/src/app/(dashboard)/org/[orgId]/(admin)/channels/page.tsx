import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { SlackCardsRow } from "./_components/slack-cards-row";
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
      {/* The guided Slack setup surface — one default path (the OneCLI app)
          with the token alternative a swap away; states route in the row.
          Full width, like every card on the admin pages. */}
      <SlackCardsRow />
      <ChannelUserLinksCard />
    </div>
  );
}
