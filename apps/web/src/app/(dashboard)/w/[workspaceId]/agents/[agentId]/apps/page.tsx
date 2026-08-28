import { redirect } from "next/navigation";

const agentBase = (workspaceId: string, agentId: string) =>
  `/w/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}`;

interface Props {
  params: Promise<{ workspaceId: string; agentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Apps folded into the agent's Connections section (§3.18 as amended). Kept as
 * a redirect so existing links — notably the "manage this connection" deep
 * link — still land on the right tab rather than a 404.
 */
export default async function AgentAppsPage({ params, searchParams }: Props) {
  const { workspaceId, agentId } = await params;
  // `URLSearchParams` re-encodes every value, so a crafted `?connection=`
  // cannot break out of the query and steer the path.
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") query.set(key, value);
    // Repeated params arrive as arrays — keep every value, not just one.
    else if (Array.isArray(value)) for (const v of value) query.append(key, v);
  }
  const search = query.toString();
  // Route params arrive DECODED: encode them back, or a crafted `%2f` in an
  // id would re-target the redirect at a different /p route (the house rule
  // for every id read off the URL).
  redirect(
    `${agentBase(workspaceId, agentId)}/connections${search ? `?${search}` : ""}`,
  );
}
