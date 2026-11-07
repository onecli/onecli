"use client";

import { useState, useMemo } from "react";
import { Search } from "lucide-react";
import { Input } from "@onecli/ui/components/input";
import { Checkbox } from "@onecli/ui/components/checkbox";
import { Button } from "@onecli/ui/components/button";
import { DialogFooter } from "@onecli/ui/components/dialog";
import { cn } from "@onecli/ui/lib/utils";
import type { PolicyDialogContentProps } from "@/lib/granular-access/types";
import { coveredBy } from "@onecli/api/lib/resource-axis";
import { UpgradeToTeamButton } from "@/ee/billing/_components/upgrade-to-team-button";
import { useHasTeamFeatures } from "../use-has-team-features";
import { useGitHubConnectionRepos } from "@/hooks/use-github-app-share";
import { useOrgMembership } from "@/hooks/use-org";

export const GithubAppPolicyDialogContent = ({
  connectionId,
  connectionScope = "workspace",
  metadata,
  policy,
  orgBoundary = null,
  onPolicyChange,
  onSave,
  onCancel,
}: PolicyDialogContentProps) => {
  // Opening reads the installation live, so repos added on GitHub show up
  // with no Refresh button. Admins only (the route is); everyone else, and
  // a failed read, falls back to the connection's stored list.
  const { data: membership } = useOrgMembership();
  const refresh = useGitHubConnectionRepos(
    connectionId,
    connectionScope,
    membership?.isAdmin === true,
  );
  const live = refresh.data;
  const available = new Map(
    (live?.available ?? []).map((repo) => [repo.toLowerCase(), repo]),
  );
  const liveRepos = live
    ? (live.selected?.flatMap(
        (repo) => available.get(repo.toLowerCase()) ?? [],
      ) ?? live.available)
    : null;
  const repos = useMemo(
    () => liveRepos ?? (metadata.repos as string[]) ?? [],
    [liveRepos, metadata.repos],
  );
  // Selecting a repository the organization doesn't allow would compose to a
  // narrower scope than asked for — the server refuses it, so don't offer it.
  // `coveredBy` is the shared containment law (null boundary = unbounded), the
  // same one the server and gateway apply — never a local re-implementation.
  const withinOrgBoundary = (repo: string) => coveredBy(repo, orgBoundary);
  const selectedRepos = new Set((policy?.repositories as string[]) ?? []);
  const isAllRepos = !policy || !policy.repositories;
  const [search, setSearch] = useState("");
  const hasTeamFeatures = useHasTeamFeatures();

  const filteredRepos = useMemo(() => {
    if (!search.trim()) return repos;
    const q = search.toLowerCase();
    return repos.filter((r) => r.toLowerCase().includes(q));
  }, [repos, search]);

  const setAllRepos = () => onPolicyChange(null);

  const setSelectedMode = () => onPolicyChange({ repositories: [] });

  const toggleRepo = (repo: string) => {
    const current = (policy?.repositories as string[]) ?? [];
    const updated = current.includes(repo)
      ? current.filter((r) => r !== repo)
      : [...current, repo];
    onPolicyChange(updated.length > 0 ? { repositories: updated } : null);
  };

  return (
    <>
      <div className="px-5 py-4">
        <div className="bg-muted inline-flex w-fit rounded-lg p-0.5">
          {(["all", "selected"] as const).map((value) => {
            const active = (value === "all") === isAllRepos;
            return (
              <button
                key={value}
                type="button"
                onClick={value === "all" ? setAllRepos : setSelectedMode}
                aria-pressed={active}
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                  active
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {value === "all" ? "All repositories" : "Selected repositories"}
              </button>
            );
          })}
        </div>

        {membership?.isAdmin === true && refresh.isFetching && (
          <p role="status" className="mt-3 text-xs">
            Refreshing repositories...
          </p>
        )}
        {membership?.isAdmin === true && refresh.isError && (
          <p role="alert" className="text-destructive mt-3 text-xs">
            Couldn&apos;t refresh repositories. Reopen this dialog to try again.
          </p>
        )}
        {!isAllRepos && (
          <div className="mt-3 space-y-2">
            {repos.length > 8 && (
              <div className="relative">
                <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
                <Input
                  aria-label="Search repositories"
                  placeholder="Search repositories..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-8 pl-8 text-xs"
                />
              </div>
            )}
            <div className="max-h-56 space-y-px overflow-y-auto rounded-md border p-1">
              {filteredRepos.map((repo) => {
                const repoName = repo.split("/").pop() ?? repo;
                const checked = selectedRepos.has(repo);
                const outside = !withinOrgBoundary(repo);
                // Only the CHECK direction is barred. A repository already
                // selected when the organization narrowed its boundary must
                // stay removable — otherwise the save it now blocks (the
                // server refuses out-of-boundary entries) could never be
                // unblocked from here.
                const lockedOut = outside && !checked;
                return (
                  <label
                    key={repo}
                    className={cn(
                      "flex items-center gap-2.5 rounded-sm px-2 py-1.5",
                      lockedOut
                        ? "cursor-not-allowed"
                        : "hover:bg-muted/50 cursor-pointer",
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggleRepo(repo)}
                      disabled={lockedOut}
                      className="size-3.5"
                    />
                    <span
                      className={cn(
                        "truncate text-xs",
                        lockedOut && "opacity-50",
                      )}
                    >
                      {repoName}
                    </span>
                    {outside && (
                      <span className="text-muted-foreground ml-auto shrink-0 text-[11px]">
                        {checked
                          ? "No longer allowed by your organization. Remove it."
                          : "Not allowed by your organization"}
                      </span>
                    )}
                  </label>
                );
              })}
              {filteredRepos.length === 0 && (
                <p className="text-muted-foreground py-4 text-center text-xs">
                  {repos.length === 0
                    ? "This connection grants access to all repositories, so there are no individual repositories to narrow to."
                    : `No repositories match “${search}”`}
                </p>
              )}
            </div>
            {selectedRepos.size > 0 && (
              <p className="text-muted-foreground text-xs">
                <span className="text-foreground font-medium">
                  {selectedRepos.size}
                </span>{" "}
                of {repos.length} selected
              </p>
            )}
          </div>
        )}
      </div>

      <DialogFooter className="border-border/50 border-t px-5 py-3">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {hasTeamFeatures ? (
          <Button
            size="sm"
            onClick={onSave}
            disabled={
              membership?.isAdmin === true &&
              (refresh.isPending || refresh.isFetching || refresh.isError)
            }
          >
            Save
          </Button>
        ) : (
          <UpgradeToTeamButton />
        )}
      </DialogFooter>
    </>
  );
};
