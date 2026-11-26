import { Suspense } from "react";
import { SettingsModal } from "./settings-modal";
import { SettingsPageBody } from "./bodies";
import { SettingsBodySkeleton } from "./settings-body-skeleton";
import { resolveSettingsModal, type SettingsScope } from "./resolve";

/**
 * The one server component every `@settings` slot page renders: resolve the
 * request for its scope, and either nothing (no modal) or the modal with the
 * page inside. Each slot page is a two-line file that names its scope.
 *
 * The frame streams ahead of the page: only the quick who-may-see-what read
 * runs before it, and the page's own reads (members, plans, usage) fill in
 * under a skeleton. A switch to another page keeps the current one on
 * screen, dimmed, until the next arrives (the boundary is already
 * revealed), so it never flashes back to the skeleton.
 */
export const SettingsSlot = async ({
  scope,
  searchParams,
}: {
  scope: SettingsScope;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) => {
  const request = await resolveSettingsModal(scope, searchParams);
  if (!request?.page) return null;
  return (
    <SettingsModal
      page={request.page}
      viewer={request.viewer}
      organizationId={scope.organizationId}
      workspaceId={scope.workspaceId}
      workspaces={request.workspaces}
    >
      <Suspense fallback={<SettingsBodySkeleton />}>
        <SettingsPageBody
          page={request.page}
          scope={scope}
          viewer={request.viewer}
          searchParams={await searchParams}
        />
      </Suspense>
    </SettingsModal>
  );
};
