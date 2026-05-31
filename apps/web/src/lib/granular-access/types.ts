import type { ComponentType } from "react";

export interface GranularAccessItem {
  id: string;
  label: string;
}

export interface PolicyDialogContentProps {
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
}
