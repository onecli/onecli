"use client";

// Alias key on purpose — in EE builds this whole module is aliased away, so
// this import only ever resolves here in the flat editions, where it is the
// SHARED registry (configs without picker dialogs).
import { granularAccessConfigs } from "@/lib/granular-access";
import type { Connection } from "@/lib/api";

/**
 * The OSS resource-scope seam (step 9.5): granular per-resource scoping
 * (GitHub repositories / Dropbox folders on a connection's injected
 * credential) is a OneCLI Cloud capability — the OSS gateway has no guard to
 * enforce it and the API locks it with a 422. Rendered only where the real
 * editor would appear (a supported provider, editable context), as a locked
 * capability hint. The EE editions alias this file to
 * `@/ee/policy-editor/resource-scope` (the real fields).
 */

export interface ResourceScopeFieldsProps {
  connection: Connection;
  policy: Record<string, unknown> | null;
  onChange: (policy: Record<string, unknown> | null) => void;
  /** Read-only contexts never show an upsell hint. */
  readOnly?: boolean;
  /** Accepted for prop parity with the EE editor; OSS has no org scope, so
   * there is never a boundary to narrow within. */
  orgPolicy?: Record<string, unknown> | null;
}

export const ResourceScopeFields: (
  props: ResourceScopeFieldsProps,
) => React.JSX.Element | null = ({ connection, readOnly = false }) => {
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
