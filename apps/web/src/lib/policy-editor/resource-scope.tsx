"use client";

import type { Connection } from "@/lib/api";

/**
 * The OSS resource-scope seam (step 9.5): granular per-resource scoping
 * (GitHub repositories / Dropbox folders on a connection's injected
 * credential) is a OneCLI Cloud capability — the OSS gateway has no guard to
 * enforce it and the API locks it with a 422. Rendered only where the real
 * editor would appear (a single specific connection on an Allow), as a locked
 * capability hint. The EE editions alias this file to
 * `@/ee/policy-editor/resource-scope` (the real fields).
 */

export interface ResourceScopeFieldsProps {
  connection: Connection;
  policy: Record<string, unknown> | null;
  onChange: (policy: Record<string, unknown> | null) => void;
}

export const ResourceScopeFields: (
  props: ResourceScopeFieldsProps,
) => React.JSX.Element = () => (
  <p className="text-muted-foreground rounded-md border border-dashed px-3 py-2 text-xs">
    Resource scoping (limit this connection to specific repositories or folders)
    is available on OneCLI Cloud.
  </p>
);
