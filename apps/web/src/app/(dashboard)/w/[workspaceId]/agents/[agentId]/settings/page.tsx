import type { Metadata } from "next";
import { AgentSettingsSection } from "./_components/agent-settings-section";

export const metadata: Metadata = {
  title: "Agent settings",
};

/** The agent's model and keys, SSH and its facts, on one page under More.
 *  The old Models and SSH URLs forward here. */
export default function AgentSettingsPage() {
  return <AgentSettingsSection />;
}
