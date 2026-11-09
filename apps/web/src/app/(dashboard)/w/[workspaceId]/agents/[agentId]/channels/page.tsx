import { redirectMergedSection } from "@/lib/dashboard/merged-section-redirect";

interface Props {
  params: Promise<{ workspaceId: string; agentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * An old URL: the Slack card sits on top of the agent's Contacts page. The
 * install return (`?connected=slack`) goes along, query intact.
 */
export default async function AgentChannelsPage({
  params,
  searchParams,
}: Props) {
  const { workspaceId, agentId } = await params;
  await redirectMergedSection(
    workspaceId,
    agentId,
    "channels",
    await searchParams,
  );
}
