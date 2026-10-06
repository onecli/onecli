import type { ComponentType } from "react";

export interface PolicyDialogContentProps {
  /** The app connection being scoped — needed by providers that browse
   * resources live (e.g. Dropbox folders) instead of reading them from
   * connect-time metadata. Providers that don't need it simply ignore it. */
  connectionId: string;
  metadata: Record<string, unknown>;
  policy: Record<string, unknown> | null;
  onPolicyChange: (policy: Record<string, unknown> | null) => void;
  onSave: () => void;
  onCancel: () => void;
  /** The organization's boundary for this connection, when it sets one: the
   * picker may only select within it, so resources outside show disabled.
   * Null = no boundary, everything the connection offers is selectable. */
  orgBoundary?: Record<string, unknown> | null;
}

export interface GranularAccessConfig {
  isSupported: (metadata: Record<string, unknown>) => boolean;
  getSelectedItems: (policy: Record<string, unknown>) => string[];
  itemLabel: { singular: string; plural: string };
  Icon: ComponentType<{ className?: string }>;
  PolicyDialogContent?: ComponentType<PolicyDialogContentProps>;
}
