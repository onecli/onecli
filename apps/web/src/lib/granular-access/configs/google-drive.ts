import { Folder } from "lucide-react";
import type { GranularAccessConfig } from "../types";

export const googleDriveConfig: GranularAccessConfig = {
  // Folders are browsed live in the policy dialog (Drive has no connect-time
  // folder list), so granular access is always available for a connected
  // Google Drive account.
  isSupported: () => true,
  getSelectedItems: (policy) => (policy.driveFolders as string[]) ?? [],
  itemLabel: { singular: "folder", plural: "folders" },
  Icon: Folder,
};
