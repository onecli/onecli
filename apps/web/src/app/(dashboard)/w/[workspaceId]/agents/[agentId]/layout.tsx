import { AgentPageFrame } from "./_components/agent-page-frame";

interface Props {
  children: React.ReactNode;
  params: Promise<{ agentId: string }>;
}

/**
 * The agent's profile page (§3.18): every section under here is a property of
 * this one agent, so the frame — header, section rail, full-height content
 * cell — wraps them all. The dashboard chrome hands this subtree the raw flex
 * cell (`isAgentPagePath`), because the Chat section needs the page's full
 * height; the other sections bring their own scroll (`SectionShell`).
 */
export default async function AgentPageLayout({ children, params }: Props) {
  const { agentId } = await params;
  return <AgentPageFrame agentId={agentId}>{children}</AgentPageFrame>;
}
