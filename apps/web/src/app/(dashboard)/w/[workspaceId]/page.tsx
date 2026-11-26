import { redirect } from "next/navigation";
import { resolveWorkspaceLanding } from "@/lib/workspaces/workspace-landing";

interface Props {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * A bare /w/<id> URL is the workspace's front door: it opens the first agent
 * in the sidebar (the oldest), or the create-agent page when there is none.
 * There is no workspace dashboard page any more.
 *
 * The query rides along, so a switch made from inside Settings
 * (`?settings=workspaces`) lands with the modal still open.
 */
export default async function WorkspaceIndexPage({
  params,
  searchParams,
}: Props) {
  const { workspaceId } = await params;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const v of Array.isArray(value) ? value : value ? [value] : [])
      query.append(key, v);
  }
  const landing = await resolveWorkspaceLanding(workspaceId);
  const qs = query.toString();
  redirect(
    qs ? `${landing}${landing.includes("?") ? "&" : "?"}${qs}` : landing,
  );
}
