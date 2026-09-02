"use client";

import { useState, useMemo, useEffect } from "react";
import { ChevronRight, Folder, Home, Loader2, Search, X } from "lucide-react";
import { Input } from "@onecli/ui/components/input";
import { Checkbox } from "@onecli/ui/components/checkbox";
import { Button } from "@onecli/ui/components/button";
import { Badge } from "@onecli/ui/components/badge";
import { DialogFooter } from "@onecli/ui/components/dialog";
import { cn } from "@onecli/ui/lib/utils";
import type { PolicyDialogContentProps } from "@/lib/granular-access/types";
import { coveredBy } from "@onecli/api/lib/resource-axis";
import { UpgradeToTeamButton } from "@/ee/billing/_components/upgrade-to-team-button";
import { getCurrentPlan } from "@/lib/user-plan";
import { isPlanAtLeast, normalizePlan } from "@onecli/api/ee/billing/plans";
import { useDropboxFolders } from "./use-dropbox-folders";

/** True when `path` is itself a selected folder or sits under one. */
const isCovered = (path: string, selected: string[]) =>
  selected.some((f) => path === f || path.startsWith(`${f}/`));

export const DropboxPolicyDialogContent = ({
  connectionId,
  policy,
  orgBoundary = null,
  onPolicyChange,
  onSave,
  onCancel,
}: PolicyDialogContentProps) => {
  // Selecting a folder the organization doesn't allow would compose to a
  // narrower scope than asked for — the server refuses it, so don't offer it.
  // `coveredBy` is the shared containment law (null boundary = unbounded), the
  // same one the server and gateway apply — never a local re-implementation.
  const withinOrgBoundary = (path: string) => coveredBy(path, orgBoundary);
  const selectedFolders = (policy?.folders as string[] | undefined) ?? [];
  const selectedSet = new Set(selectedFolders);
  const isAllFolders = !policy || !policy.folders;

  const [search, setSearch] = useState("");
  const [currentPath, setCurrentPath] = useState(""); // "" = account root

  // Optimistically assume Team until the plan loads, so the Save button doesn't
  // flash an upgrade CTA for paying customers. Entitlement via the shared
  // user-plan seam (cloud → real plan).
  const [hasTeamFeatures, setHasTeamFeatures] = useState(true);
  useEffect(() => {
    // Team-tier features unlock at team OR above (enterprise), so rank-compare
    // instead of exact-matching. Only downgrade from the optimistic default on a
    // DEFINITE plan — getCurrentPlan returns null on error, matching the old cloud
    // behavior (stay optimistic so a transient fetch error doesn't flash an
    // upgrade CTA for paying customers).
    getCurrentPlan().then((plan) => {
      if (plan !== null)
        setHasTeamFeatures(isPlanAtLeast(normalizePlan(plan), "team"));
    });
  }, []);

  const {
    data: folders = [],
    isPending,
    isError,
  } = useDropboxFolders(connectionId, currentPath, !isAllFolders);

  const filteredFolders = useMemo(() => {
    if (!search.trim()) return folders;
    const q = search.toLowerCase();
    return folders.filter((f) => f.name.toLowerCase().includes(q));
  }, [folders, search]);

  const segments = currentPath ? currentPath.split("/").filter(Boolean) : [];

  const setAllFolders = () => onPolicyChange(null);
  const setSelectedMode = () => onPolicyChange({ folders: [] });

  const toggleFolder = (pathLower: string) => {
    const updated = selectedSet.has(pathLower)
      ? selectedFolders.filter((p) => p !== pathLower)
      : [...selectedFolders, pathLower];
    // Empty selection reverts to "all folders" (matches the GitHub App dialog).
    onPolicyChange(updated.length > 0 ? { folders: updated } : null);
  };

  const navigateTo = (depth: number) => {
    setSearch("");
    setCurrentPath(depth === 0 ? "" : `/${segments.slice(0, depth).join("/")}`);
  };

  const drillInto = (pathLower: string) => {
    setSearch("");
    setCurrentPath(pathLower);
  };

  return (
    <>
      <div className="px-5 py-4">
        <div className="bg-muted inline-flex w-fit rounded-lg p-0.5">
          {(["all", "selected"] as const).map((value) => {
            const active = (value === "all") === isAllFolders;
            return (
              <button
                key={value}
                type="button"
                onClick={value === "all" ? setAllFolders : setSelectedMode}
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                  active
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {value === "all" ? "All folders" : "Selected folders"}
              </button>
            );
          })}
        </div>

        {!isAllFolders && (
          <div className="mt-3 space-y-2">
            {/* Breadcrumb */}
            <div className="text-muted-foreground flex items-center gap-1 text-xs">
              <button
                type="button"
                onClick={() => navigateTo(0)}
                className="hover:text-foreground inline-flex items-center gap-1"
              >
                <Home className="size-3" /> Home
              </button>
              {segments.map((seg, i) => (
                <span key={i} className="inline-flex items-center gap-1">
                  <ChevronRight className="size-3 opacity-50" />
                  <button
                    type="button"
                    onClick={() => navigateTo(i + 1)}
                    className="hover:text-foreground max-w-[8rem] truncate"
                  >
                    {seg}
                  </button>
                </span>
              ))}
            </div>

            {/* Search within the current folder */}
            <div className="relative">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input
                placeholder="Search this folder..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 pl-8 text-xs"
              />
            </div>

            {/* Folder list */}
            <div className="max-h-56 space-y-px overflow-y-auto rounded-md border p-1">
              {isPending ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="text-muted-foreground size-4 animate-spin" />
                </div>
              ) : isError ? (
                <p className="text-muted-foreground py-4 text-center text-xs">
                  Couldn&rsquo;t load folders. The connection may be missing the
                  file metadata permission.
                </p>
              ) : filteredFolders.length === 0 ? (
                <p className="text-muted-foreground py-4 text-center text-xs">
                  {search
                    ? `No folders match "${search}"`
                    : "No subfolders here"}
                </p>
              ) : (
                filteredFolders.map((folder) => {
                  const directlySelected = selectedSet.has(folder.pathLower);
                  const covered =
                    !directlySelected &&
                    isCovered(folder.pathLower, selectedFolders);
                  const outside = !withinOrgBoundary(folder.pathLower);
                  // Only the CHECK direction is barred: a folder selected
                  // before the organization narrowed its boundary must stay
                  // removable, or the save it blocks could never be unblocked.
                  const lockedOut = covered || (outside && !directlySelected);
                  return (
                    <div
                      key={folder.id}
                      className="hover:bg-muted/50 flex items-center gap-2.5 rounded-sm px-2 py-1.5"
                    >
                      <Checkbox
                        checked={directlySelected || covered}
                        disabled={lockedOut}
                        onCheckedChange={() => toggleFolder(folder.pathLower)}
                        aria-label={folder.name}
                        className={cn("size-3.5", lockedOut && "opacity-50")}
                      />
                      {/* Drilling in stays available even outside the boundary
                          — a subfolder further down may well be inside it — so
                          this button is never dimmed. */}
                      <button
                        type="button"
                        onClick={() => drillInto(folder.pathLower)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <Folder className="text-muted-foreground size-3.5 shrink-0" />
                        <span
                          className={cn(
                            "truncate text-xs",
                            lockedOut && "opacity-50",
                          )}
                        >
                          {folder.name}
                        </span>
                        {covered && (
                          <span className="text-muted-foreground shrink-0 text-[11px]">
                            via parent
                          </span>
                        )}
                        {outside && (
                          <span className="text-muted-foreground shrink-0 text-[11px]">
                            {directlySelected
                              ? "No longer allowed by your organization. Remove it."
                              : "Not allowed by your organization"}
                          </span>
                        )}
                        <ChevronRight className="text-muted-foreground/40 ml-auto size-3.5 shrink-0" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            {selectedFolders.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-muted-foreground text-xs">
                  <span className="text-foreground font-medium">
                    {selectedFolders.length}
                  </span>{" "}
                  {selectedFolders.length === 1 ? "folder" : "folders"} selected
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {selectedFolders.map((p) => (
                    <Badge
                      key={p}
                      variant="secondary"
                      className="max-w-full gap-1 py-1 pr-1 pl-2 font-normal"
                    >
                      <Folder className="size-3 shrink-0" />
                      <span className="truncate">{p}</span>
                      <button
                        type="button"
                        onClick={() => toggleFolder(p)}
                        aria-label={`Remove ${p}`}
                        className="text-muted-foreground hover:bg-foreground/10 hover:text-foreground -mr-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm transition-colors"
                      >
                        <X className="size-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              </div>
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
