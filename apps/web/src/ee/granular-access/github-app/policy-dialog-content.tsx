"use client";

import { useState, useMemo, useEffect } from "react";
import { Search } from "lucide-react";
import { Input } from "@onecli/ui/components/input";
import { Checkbox } from "@onecli/ui/components/checkbox";
import { Button } from "@onecli/ui/components/button";
import { DialogFooter } from "@onecli/ui/components/dialog";
import { cn } from "@onecli/ui/lib/utils";
import type { PolicyDialogContentProps } from "@/lib/granular-access/types";
import { coveredBy } from "@onecli/api/lib/resource-axis";
import { UpgradeToTeamButton } from "@/ee/billing/_components/upgrade-to-team-button";
import { getCurrentPlan } from "@/lib/user-plan";
import { isPlanAtLeast, normalizePlan } from "@onecli/api/ee/billing/plans";

export const GithubAppPolicyDialogContent = ({
  metadata,
  policy,
  orgBoundary = null,
  onPolicyChange,
  onSave,
  onCancel,
}: PolicyDialogContentProps) => {
  const repos = useMemo(
    () => (metadata.repos as string[]) ?? [],
    [metadata.repos],
  );
  // Selecting a repository the organization doesn't allow would compose to a
  // narrower scope than asked for — the server refuses it, so don't offer it.
  // `coveredBy` is the shared containment law (null boundary = unbounded), the
  // same one the server and gateway apply — never a local re-implementation.
  const withinOrgBoundary = (repo: string) => coveredBy(repo, orgBoundary);
  const selectedRepos = new Set((policy?.repositories as string[]) ?? []);
  const isAllRepos = !policy || !policy.repositories;
  const [search, setSearch] = useState("");
  const [hasTeamFeatures, setHasTeamFeatures] = useState(true);

  useEffect(() => {
    // Entitlement via the shared user-plan seam (cloud → real plan). Team-tier features unlock at team OR above,
    // so rank-compare instead of exact-matching. Only downgrade from the
    // optimistic default on a DEFINITE plan — getCurrentPlan returns null on
    // error (stay optimistic so a transient fetch error doesn't flash an
    // upgrade CTA).
    getCurrentPlan().then((plan) => {
      if (plan !== null)
        setHasTeamFeatures(isPlanAtLeast(normalizePlan(plan), "team"));
    });
  }, []);

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

        {!isAllRepos && (
          <div className="mt-3 space-y-2">
            {repos.length > 8 && (
              <div className="relative">
                <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
                <Input
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
          <Button size="sm" onClick={onSave}>
            Save
          </Button>
        ) : (
          <UpgradeToTeamButton />
        )}
      </DialogFooter>
    </>
  );
};
