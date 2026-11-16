"use client";

import { ScrollToHash } from "@/lib/dashboard/scroll-to-hash";
import { ChannelsSection } from "../../channels/_components/channels-section";

/**
 * The Slack card on top of Contacts: the
 * old Channels page's content, anchored `#slack` so the old URL lands on
 * it.
 */
export const ContactsSlackBlock = () => (
  <section id="slack" aria-labelledby="slack-heading" className="mb-8">
    <ScrollToHash />
    <div className="mb-4">
      <h2 id="slack-heading" className="text-base font-semibold">
        Slack
      </h2>
      <p className="text-muted-foreground text-sm">
        Where people reach this agent besides chat.
      </p>
    </div>
    <ChannelsSection />
  </section>
);
