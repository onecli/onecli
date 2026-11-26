import type { ComponentType } from "react";
import type { MissingPermission } from "@onecli/api/apps/missing-permissions";

export interface PolicyDialogContentProps {
  /** The app connection being scoped — needed by providers that browse
   * resources live (e.g. Dropbox folders) instead of reading them from
   * connect-time metadata. Providers that don't need it simply ignore it. */
  connectionId: string;
  /** Where the connection lives, for providers that read their resource
   * list live from the provider (GitHub) at that level. */
  connectionScope?: "workspace" | "organization";
  metadata: Record<string, unknown>;
  policy: Record<string, unknown> | null;
  onPolicyChange: (policy: Record<string, unknown> | null) => void;
  onSave: () => void;
  onCancel: () => void;
  /** The organization's boundary for this connection, when it sets one: the
   * picker may only select within it, so resources outside show disabled.
   * Null = no boundary, everything the connection offers is selectable. */
  orgBoundary?: Record<string, unknown> | null;
  /** Requested permissions the connection wasn't granted. A picker whose
   * listing needs one of them shows why instead of a generic load error. */
  missingPermissions?: MissingPermission[];
  /** Re-run the provider consent for this connection (absent when the
   * caller can't reconnect it here, e.g. an organization connection). */
  onReconnect?: () => void;
}

export interface GranularAccessConfig {
  isSupported: (metadata: Record<string, unknown>) => boolean;
  getSelectedItems: (policy: Record<string, unknown>) => string[];
  itemLabel: { singular: string; plural: string };
  Icon: ComponentType<{ className?: string }>;
  PolicyDialogContent?: ComponentType<PolicyDialogContentProps>;
}
