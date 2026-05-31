import { GitBranch } from "lucide-react";
import type { GranularAccessConfig } from "../types";

export const githubAppConfig: GranularAccessConfig = {
  isSupported: (meta) => Array.isArray(meta.repos) && meta.repos.length > 0,
  getItems: (meta) =>
    ((meta.repos as string[]) ?? []).map((repo) => ({
      id: repo,
      label: repo.split("/").pop() ?? repo,
    })),
  buildPolicy: (repos) => (repos.length > 0 ? { repositories: repos } : {}),
  getSelectedItems: (policy) => (policy.repositories as string[]) ?? [],
  itemLabel: { singular: "repository", plural: "repositories" },
  Icon: GitBranch,
};
