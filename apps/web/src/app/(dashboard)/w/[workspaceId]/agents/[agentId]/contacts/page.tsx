import { Suspense } from "react";
import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { ContactsSection } from "./_components/contacts-section";
import { ContactsSlackBlock } from "./_components/contacts-slack-block";

export const metadata: Metadata = {
  title: "Contacts",
};

/**
 * Where the agent is reached (the Slack card), then who may reach it. The
 * Slack block consumes the `?connected=slack` install return, so it needs
 * the Suspense boundary `useSearchParams` requires.
 */
export default function AgentContactsPage() {
  return (
    <>
      <div className="mb-6">
        <PageHeader
          title="Contacts"
          character="drop-cheer"
          description="Where people reach this agent, and who it talks to."
        />
      </div>
      <Suspense>
        <ContactsSlackBlock />
      </Suspense>
      <ContactsSection />
    </>
  );
}
