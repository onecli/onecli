import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { SlackIntegrationCard } from "./_components/slack-integration-card";
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
      <SlackIntegrationCard />
      <ChannelUserLinksCard />
    </div>
  );
}
