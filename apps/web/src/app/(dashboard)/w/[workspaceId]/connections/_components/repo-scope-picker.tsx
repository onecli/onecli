"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Loader2, Search } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Checkbox } from "@onecli/ui/components/checkbox";
import { Input } from "@onecli/ui/components/input";
import { cn } from "@onecli/ui/lib/utils";
import {
  isGitHubUrl,
  openGitHubSettingsPopup,
} from "@/lib/github-settings-popup";

export type RepoScopeMode = "all" | "selected";

export interface RepoScopePickerProps {
  mode: RepoScopeMode;
  onModeChange: (mode: RepoScopeMode) => void;
  /** Every repo the installation covers. */
  repos: string[];
  picked: Set<string>;
  onPickedChange: (next: Set<string>) => void;
  loading?: boolean;
  error?: unknown;
  truncated?: boolean;
  /** The GitHub account, for the "missing a repository?" hint. */
  account?: string | null;
  /** Re-reads the installation's repos from GitHub. Called on its own when
   * the user comes back from "Manage on GitHub", so there is no button. */
  onReload?: () => void;
  /** The installation's settings page on GitHub, where an owner adds or
   * removes repositories. Present = a "Manage on GitHub" button. */
  manageUrl?: string | null;
}

/**
 * Which repositories a GitHub App connection reaches: every repo the
 * installation covers, or a picked subset ("Edit repositories").
 */
export const RepoScopePicker = ({
  mode,
  onModeChange,
  repos,
  picked,
  onPickedChange,
  loading = false,
  error,
  truncated = false,
  account,
  onReload,
  manageUrl,
}: RepoScopePickerProps) => {
  const [search, setSearch] = useState("");

  // Back from GitHub's settings: pick up the repos the owner just added.
  const awaitingReturn = useRef(false);
  const reloadRef = useRef(onReload);
  useEffect(() => {
    reloadRef.current = onReload;
  }, [onReload]);
  useEffect(() => {
    const onFocus = () => {
      if (!awaitingReturn.current) return;
      awaitingReturn.current = false;
      reloadRef.current?.();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  const openManage = () => {
    awaitingReturn.current = openGitHubSettingsPopup(manageUrl);
  };
  const canManage = isGitHubUrl(manageUrl);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? repos.filter((r) => r.toLowerCase().includes(q)) : repos;
  }, [repos, search]);

  const missing = [...picked].filter((repo) => !repos.includes(repo));
  const toggle = (repo: string) => {
    const next = new Set(picked);
    if (next.has(repo)) next.delete(repo);
    else if (next.size < 500) next.add(repo);
    onPickedChange(next);
  };
  const allFilteredPicked =
    filtered.length > 0 && filtered.every((r) => picked.has(r));
  const toggleAllFiltered = () => {
    const next = new Set(picked);
    for (const r of filtered) {
      if (allFilteredPicked) next.delete(r);
      else if (next.size < 500) next.add(r);
    }
    onPickedChange(next);
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <div className="bg-muted inline-flex w-fit rounded-lg p-0.5">
          {(["all", "selected"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onModeChange(value)}
              aria-pressed={mode === value}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                mode === value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {value === "all" ? "All repositories" : "Selected repositories"}
            </button>
          ))}
        </div>
        {canManage && (
          <Button size="xs" variant="ghost" onClick={openManage}>
            <ExternalLink />
            Manage on GitHub
          </Button>
        )}
      </div>

      {mode === "all" ? (
        <div role="status" className="text-muted-foreground mt-3 text-xs">
          {loading
            ? "Refreshing repositories..."
            : error
              ? "Couldn't refresh repositories. Reopen this dialog to try again."
              : "Every repository this installation covers, including ones the GitHub org owner adds later."}
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {loading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="text-muted-foreground size-5 animate-spin" />
            </div>
          ) : error ? (
            <p className="text-destructive py-2 text-xs">
              {error instanceof Error
                ? error.message
                : "Couldn't load repositories"}
            </p>
          ) : (
            <>
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
              <div className="max-h-64 space-y-px overflow-y-auto rounded-md border p-1">
                {filtered.length > 1 && (
                  <label className="hover:bg-muted/50 flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5">
                    <Checkbox
                      checked={allFilteredPicked}
                      onCheckedChange={toggleAllFiltered}
                      className="size-3.5"
                    />
                    <span className="text-muted-foreground text-xs">
                      {search ? "Select all matches" : "Select all"}
                    </span>
                  </label>
                )}
                {filtered.map((repo) => (
                  <label
                    key={repo}
                    className="hover:bg-muted/50 flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5"
                  >
                    <Checkbox
                      disabled={!picked.has(repo) && picked.size >= 500}
                      checked={picked.has(repo)}
                      onCheckedChange={() => toggle(repo)}
                      className="size-3.5"
                    />
                    <span className="truncate text-xs">
                      {repo.split("/").pop() ?? repo}
                    </span>
                  </label>
                ))}
                {filtered.length === 0 && (
                  <p className="text-muted-foreground py-4 text-center text-xs">
                    {repos.length === 0
                      ? "This installation doesn't cover any repositories yet."
                      : `No repositories match “${search}”`}
                  </p>
                )}
              </div>
              <p className="text-muted-foreground text-xs">
                <span className="text-foreground font-medium">
                  {picked.size}
                </span>{" "}
                of {repos.length} selected
                {truncated && " (showing the first 1000)"}
              </p>
              {missing.length > 0 && (
                <div role="alert" className="space-y-2 text-xs">
                  <p>
                    These selected repositories are no longer available. Remove
                    them before saving, or restore access on GitHub.
                  </p>
                  {missing.map((repo) => (
                    <Button
                      key={repo}
                      size="xs"
                      variant="outline"
                      onClick={() => toggle(repo)}
                    >
                      Remove {repo}
                    </Button>
                  ))}
                </div>
              )}
              <p className="text-muted-foreground text-xs">
                Select up to 500 repositories.
              </p>
              <p className="text-muted-foreground text-[11px]">
                Missing a repository? A GitHub owner of{" "}
                {account ?? "this account"} adds it to the app&apos;s
                installation
                {canManage ? (
                  <>
                    {" "}
                    in{" "}
                    <button
                      type="button"
                      onClick={openManage}
                      className="text-foreground underline underline-offset-2"
                    >
                      Manage on GitHub
                    </button>
                    . The list refreshes when you come back.
                  </>
                ) : (
                  " on GitHub first, then reopen this list."
                )}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
};
