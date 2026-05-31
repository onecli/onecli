import { githubAppConfig } from "./configs/github-app";
import type { GranularAccessConfig } from "./types";

export type {
  GranularAccessConfig,
  GranularAccessItem,
  PolicyDialogContentProps,
} from "./types";

export const granularAccessConfigs = new Map<string, GranularAccessConfig>([
  ["github-app", githubAppConfig],
]);
