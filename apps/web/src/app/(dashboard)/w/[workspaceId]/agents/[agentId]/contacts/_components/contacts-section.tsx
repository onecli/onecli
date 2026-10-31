"use client";

import dynamic from "next/dynamic";
import { useInstance } from "@/hooks/use-instance";
import { useAgentPageAgent } from "../../_components/agent-page-frame";
import { ContactsList } from "./contacts-list";

// "Acts as you" (licensed: granular_access). Lazy, so the licensed layer
// never enters the free bundle's static graph; mounted only when entitled.
const ActAsYouContacts = dynamic(() =>
  import("@/ee/slack-read/act-as-you-contacts").then((m) => m.ActAsYouContacts),
);

/**
 * The agent's Contacts: one list of who it deals with. Entitled, the
 * licensed "acts as you" layer wraps it, adding your Slack line on top and
 * the "Reads as you" / "Writes as you" columns on its rows.
 */
export const ContactsSection = () => {
  const agent = useAgentPageAgent();
  const instance = useInstance();

  if (instance?.entitled !== true) return <ContactsList />;

  return (
    <ActAsYouContacts agentId={agent.id} agentName={agent.name}>
      {(slot) => <ContactsList actAsYou={slot} />}
    </ActAsYouContacts>
  );
};
