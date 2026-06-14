import type { ComponentType } from "react";

export interface GranularAccessItem {
  id: string;
  label: string;
}

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
}

export interface GranularAccessConfig {
  isSupported: (metadata: Record<string, unknown>) => boolean;
  getItems: (metadata: Record<string, unknown>) => GranularAccessItem[];
  buildPolicy: (selectedItemIds: string[]) => Record<string, unknown>;
  getSelectedItems: (policy: Record<string, unknown>) => string[];
  itemLabel: { singular: string; plural: string };
  Icon: ComponentType<{ className?: string }>;
  PolicyDialogContent?: ComponentType<PolicyDialogContentProps>;
  /** Optional override for the one-line access summary shown on the row.
   * Use when the count of granted items can't be derived from `getItems`
   * (e.g. live-browsed Dropbox folders, where `getItems` returns []). */
  formatSummary?: (
    policy: Record<string, unknown> | null,
    metadata: Record<string, unknown>,
  ) => string;
}
