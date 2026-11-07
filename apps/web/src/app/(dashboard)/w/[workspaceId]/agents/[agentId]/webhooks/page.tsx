import type { Metadata } from "next";
import { WebhooksSection } from "./_components/webhooks-section";

export const metadata: Metadata = {
  title: "Webhooks",
};

export default function AgentWebhooksPage() {
  return <WebhooksSection />;
}
