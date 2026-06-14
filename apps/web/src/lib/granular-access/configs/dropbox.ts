import { Folder } from "lucide-react";
import type { GranularAccessConfig } from "../types";

export const dropboxConfig: GranularAccessConfig = {
  // Folders are browsed live in the policy dialog (Dropbox has no
  // connect-time folder list), so granular access is always available for a
  // connected Dropbox account.
  isSupported: () => true,
  // Items come from the live folder browser, not connection metadata.
  getItems: () => [],
  buildPolicy: (folders) => (folders.length > 0 ? { folders } : {}),
  getSelectedItems: (policy) => (policy.folders as string[]) ?? [],
  itemLabel: { singular: "folder", plural: "folders" },
  Icon: Folder,
  formatSummary: (policy) => {
    const folders = (policy?.folders as string[] | undefined) ?? [];
    return folders.length > 0
      ? `${folders.length} ${folders.length === 1 ? "folder" : "folders"}`
      : "All folders";
  },
};
