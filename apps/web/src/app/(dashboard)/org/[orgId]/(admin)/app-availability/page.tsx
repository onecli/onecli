import { redirect } from "next/navigation";

/**
 * App availability moved under Organization Settings — it is org-wide
 * administration, not a top-level destination. This keeps the old top-level
 * URL (bookmarks, links already handed out) landing on the new page.
 */
export default async function Page({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  redirect(`/org/${orgId}/settings/app-availability`);
}
