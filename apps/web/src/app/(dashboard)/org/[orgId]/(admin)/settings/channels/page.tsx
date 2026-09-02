import { redirect } from "next/navigation";

/**
 * Channels moved out of Organization Settings to the org level — it is an
 * integration surface (workspaces agents join), not a settings pane. This
 * keeps the old settings URL landing on the new page.
 */
export default async function Page({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  redirect(`/org/${orgId}/channels`);
}
