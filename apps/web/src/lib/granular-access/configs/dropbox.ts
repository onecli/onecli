import { Folder } from "lucide-react";
import type { GranularAccessConfig } from "../types";

export const dropboxConfig: GranularAccessConfig = {
  // Folders are browsed live in the policy dialog (Dropbox has no
  // connect-time folder list), so granular access is always available for a
  // connected Dropbox account.
  isSupported: () => true,
  getSelectedItems: (policy) => (policy.folders as string[]) ?? [],
  itemLabel: { singular: "folder", plural: "folders" },
  Icon: Folder,
};
