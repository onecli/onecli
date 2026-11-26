import { SettingsSlot } from "@/lib/settings-modal/settings-slot";

interface Props {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * `?settings=<page>` on any `/org/<id>/...` URL: the org-scoped modal.
 *
 * A catch-all, because a parallel slot only renders beside the routes it
 * has a page for: `[...rest]` is how one slot page covers every page under
 * the org without a twin per route. The `default.tsx` above fills the slot
 * where even this does not reach (the bare `/org/<id>`, which redirects).
 */
export default async function OrgSettingsSlot({ params, searchParams }: Props) {
  if (!(await searchParams).settings) return null;
  const { orgId } = await params;
  return (
    <SettingsSlot
      scope={{ organizationId: orgId }}
      searchParams={searchParams}
    />
  );
}
