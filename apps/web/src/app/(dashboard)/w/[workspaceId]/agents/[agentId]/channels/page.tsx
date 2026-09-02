import { Suspense } from "react";
import type { Metadata } from "next";
import { ChannelsSection } from "./_components/channels-section";

export const metadata: Metadata = {
  // The rail says "Slack" — the provider a user recognizes — so the tab does
  // too. The route stays `channels`: that is the provider-neutral layer.
  title: "Slack",
};

/** `ChannelsSection` consumes the `?connected=slack` install-return param, so
 *  it needs the Suspense boundary `useSearchParams` requires. */
export default function AgentChannelsPage() {
  return (
    <Suspense>
      <ChannelsSection />
    </Suspense>
  );
}
