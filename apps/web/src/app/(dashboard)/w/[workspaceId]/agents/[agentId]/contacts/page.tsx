import type { Metadata } from "next";
import { ContactsSection } from "./_components/contacts-section";

export const metadata: Metadata = {
  title: "Contacts",
};

export default function AgentContactsPage() {
  return <ContactsSection />;
}
