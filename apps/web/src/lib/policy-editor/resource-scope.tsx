"use client";

import dynamic from "next/dynamic";
import { granularAccessConfigs } from "@/lib/granular-access";
import { IS_CLOUD } from "@/lib/env";
import type { ResourceScopeFieldsProps } from "@/ee/policy-editor/_components/resource-scope-fields";

export type { ResourceScopeFieldsProps };

// Loaded on demand so the provider pickers (GitHub repos, Dropbox folders +
// their hooks) stay out of the onprem chunk — `IS_CLOUD` is a runtime value the
// bundler cannot fold, so a plain import would ship them to every edition.
const EeResourceScopeFields = dynamic(
  () =>
    import("@/ee/policy-editor/_components/resource-scope-fields").then(
      (m) => m.ResourceScopeFields,
    ),
  { ssr: false },
);

/**
 * Granular per-resource scoping (GitHub repositories / Dropbox folders on a
 * connection's injected credential). Cloud renders the real editor; onprem
 * shows a locked capability hint matching the API's 422
 * (`policy-onprem-locks`) until the licensing work revisits entitlement.
 */
export const ResourceScopeFields = (props: ResourceScopeFieldsProps) => {
  if (IS_CLOUD) return <EeResourceScopeFields {...props} />;

  const { connection, readOnly = false } = props;
  const meta = (connection.metadata as Record<string, unknown> | null) ?? {};
  const config = granularAccessConfigs.get(connection.provider);
  if (!config?.isSupported(meta) || readOnly) return null;
  return (
    <p className="text-muted-foreground rounded-md border border-dashed px-3 py-2 text-xs">
      Resource scoping (limit this connection to specific repositories or
      folders) is available on OneCLI Cloud.
    </p>
  );
};
