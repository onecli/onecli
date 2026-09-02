import dynamic from "next/dynamic";
import { githubAppConfig } from "@/lib/granular-access/configs/github-app";
import { dropboxConfig } from "@/lib/granular-access/configs/dropbox";
import type { GranularAccessConfig } from "@/lib/granular-access/types";

export type {
  GranularAccessConfig,
  GranularAccessItem,
  PolicyDialogContentProps,
} from "@/lib/granular-access/types";

// The pickers (and their hooks/billing imports) load lazily so this config map
// stays data-only in the shared chunk — a static import here would drag them
// into every consumer of the map, defeating the dynamic() in resource-scope.
const GithubAppPolicyDialogContent = dynamic(() =>
  import("./github-app/policy-dialog-content").then(
    (m) => m.GithubAppPolicyDialogContent,
  ),
);

const DropboxPolicyDialogContent = dynamic(() =>
  import("./dropbox/policy-dialog-content").then(
    (m) => m.DropboxPolicyDialogContent,
  ),
);

export const granularAccessConfigs = new Map<string, GranularAccessConfig>([
  [
    "github-app",
    { ...githubAppConfig, PolicyDialogContent: GithubAppPolicyDialogContent },
  ],
  [
    "dropbox",
    { ...dropboxConfig, PolicyDialogContent: DropboxPolicyDialogContent },
  ],
]);
