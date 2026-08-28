import type { Metadata } from "next";
import { SshSection } from "./_components/ssh-section";

export const metadata: Metadata = {
  title: "SSH",
};

export default function AgentSshPage() {
  return <SshSection />;
}
