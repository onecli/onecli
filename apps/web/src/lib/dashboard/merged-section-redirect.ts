import { redirect } from "next/navigation";
import { requireAccessibleWorkspace } from "@/lib/workspaces/workspace-access";
import { mergedAgentPagePath, type MergedAgentSection } from "@/lib/navigation";

/**
 * An agent section whose content moved into a merged page: the old URL
 * forwards to its block there (`MERGED_AGENT_SECTIONS`, the same map the
 * in-app links read), carrying the query string so an install-return
 * (`?connected=slack`) still lands where its consumer now lives. Server
 * side, so nothing flashes.
 *
 * A Next `redirect()` is non-permanent (307): a cached 308 would outlive
 * a second move.
 */
export const redirectMergedSection = async (
  workspaceId: string,
  agentId: string,
  section: MergedAgentSection,
  searchParams: Record<string, string | string[] | undefined> = {},
): Promise<never> => {
  await requireAccessibleWorkspace(workspaceId);
  // `URLSearchParams` re-encodes every value, so a crafted param cannot
  // break out of the query and steer the path (the apps/ redirect's rule).
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string") query.set(key, value);
    else if (Array.isArray(value)) for (const v of value) query.append(key, v);
  }
  redirect(
    mergedAgentPagePath(workspaceId, agentId, section, query.toString()),
  );
};
