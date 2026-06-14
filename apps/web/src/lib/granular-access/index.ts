import { githubAppConfig } from "./configs/github-app";
import { dropboxConfig } from "./configs/dropbox";
import type { GranularAccessConfig } from "./types";

export type {
  GranularAccessConfig,
  GranularAccessItem,
  PolicyDialogContentProps,
} from "./types";

export const granularAccessConfigs = new Map<string, GranularAccessConfig>([
  ["github-app", githubAppConfig],
  ["dropbox", dropboxConfig],
]);
