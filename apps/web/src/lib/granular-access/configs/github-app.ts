import { GitBranch } from "lucide-react";
import type { GranularAccessConfig } from "../types";

export const githubAppConfig: GranularAccessConfig = {
  // Granular repo scoping applies whenever the connection can be scoped: an
  // installation that grants ALL repositories (`repositorySelection: "all"` —
  // its concrete `repos` list may be empty or not enumerated), or one that
  // already lists specific repos. Both show "All repositories · Manage"
  // (defaulting to unrestricted); only a connection with neither signal is
  // genuinely un-scopable and stays hidden.
  isSupported: (meta) =>
    meta.repositorySelection === "all" ||
    (Array.isArray(meta.repos) && meta.repos.length > 0),
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
