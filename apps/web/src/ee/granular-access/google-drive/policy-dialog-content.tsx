"use client";

import { useState, useMemo, useCallback } from "react";
import { Folder, Loader2, Search, X } from "lucide-react";
import { Input } from "@onecli/ui/components/input";
import { Button } from "@onecli/ui/components/button";
import { Badge } from "@onecli/ui/components/badge";
import { DialogFooter } from "@onecli/ui/components/dialog";
import { cn } from "@onecli/ui/lib/utils";
import type { PolicyDialogContentProps } from "@/lib/granular-access/types";
import { coveredBy } from "@onecli/api/lib/resource-axis";
import { UpgradeToTeamButton } from "@/ee/billing/_components/upgrade-to-team-button";
import { useHasTeamFeatures } from "../use-has-team-features";
import {
  useGoogleDriveFolderNames,
  useGoogleDriveFolders,
} from "./use-google-drive-folders";
import { FolderRow, type FolderCrumb } from "./folder-row";

/**
 * Google Drive folder picker: an expandable tree of My Drive and shared
 * drives, each row showing its direct subfolder and file counts. Drive
 * addresses folders by opaque ID, so a selection is stored as the CHAIN of IDs
 * from the top down to it (`<sharedDriveOrTopFolder>/<…>/<folder>`) — the
 * gateway checks the whole chain against Drive's live parent links on every
 * agent request.
 */
export const GoogleDrivePolicyDialogContent = ({
  connectionId,
  policy,
  orgBoundary = null,
  onPolicyChange,
  onSave,
  onCancel,
}: PolicyDialogContentProps) => {
  // Selecting a folder the organization doesn't allow would compose to a
  // narrower scope than asked for — the server refuses it, so don't offer it.
  // `coveredBy` is the shared containment law (null boundary = unbounded).
  const withinOrgBoundary = useCallback(
    (chain: string) => coveredBy(chain, orgBoundary),
    [orgBoundary],
  );
  const selectedChains = useMemo(
    () => (policy?.driveFolders as string[] | undefined) ?? [],
    [policy],
  );
  const selectedSet = useMemo(() => new Set(selectedChains), [selectedChains]);
  const isAllFolders = !policy || !policy.driveFolders;

  const [search, setSearch] = useState("");

  const hasTeamFeatures = useHasTeamFeatures();

  const {
    data: folders = [],
    isPending,
    isError,
  } = useGoogleDriveFolders(connectionId, "", !isAllFolders);

  // Saved chains hold IDs only; label them with live names. Keyed on the
  // joined chains so a re-render with the same selection doesn't refetch.
  const chainsKey = selectedChains.join(",");
  const savedIds = useMemo(
    () => (chainsKey ? chainsKey.split(",").flatMap((c) => c.split("/")) : []),
    [chainsKey],
  );
  const { data: names = {} } = useGoogleDriveFolderNames(
    connectionId,
    savedIds,
  );
  // Names of the folders checked in this session, so a fresh selection is
  // labelled immediately (before the names lookup refetches). Recorded in the
  // click handler that selects them — no effect mirrors the listings.
  const [picked, setPicked] = useState<Record<string, string>>({});
  const known = useMemo(() => {
    const m: Record<string, string> = { ...picked };
    for (const [id, name] of Object.entries(names)) if (name) m[id] = name;
    for (const f of folders) m[f.id] = f.name;
    return m;
  }, [names, picked, folders]);
  const chainLabel = (chain: string) =>
    chain
      .split("/")
      .map((id) => known[id] ?? id)
      .join(" / ");

  const filteredFolders = useMemo(() => {
    if (!search.trim()) return folders;
    const q = search.toLowerCase();
    return folders.filter((f) => f.name.toLowerCase().includes(q));
  }, [folders, search]);

  const setAllFolders = () => onPolicyChange(null);
  const setSelectedMode = () => onPolicyChange({ driveFolders: [] });

  /** Selects or clears `chain`; `trail` names each of its folders (top
   * first) when the user picked it from the tree. */
  const toggleChain = useCallback(
    (chain: string, trail?: FolderCrumb[]) => {
      const removing = selectedSet.has(chain);
      const updated = removing
        ? selectedChains.filter((c) => c !== chain)
        : [...selectedChains, chain];
      if (!removing && trail) {
        setPicked((prev) => ({
          ...prev,
          ...Object.fromEntries(trail.map((c) => [c.id, c.name])),
        }));
      }
      // Empty selection reverts to "all folders" (matches the Dropbox dialog).
      onPolicyChange(updated.length > 0 ? { driveFolders: updated } : null);
    },
    [selectedChains, selectedSet, onPolicyChange],
  );

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
            <div className="relative">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input
                placeholder="Search top-level folders…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 pl-8 text-xs"
              />
            </div>

            <div
              role="group"
              aria-label="Google Drive folders"
              className="max-h-72 space-y-px overflow-y-auto rounded-md border p-1"
            >
              {isPending ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="text-muted-foreground size-4 animate-spin" />
                </div>
              ) : isError ? (
                <p className="text-muted-foreground py-4 text-center text-xs">
                  Couldn&rsquo;t load folders. Try reconnecting Google Drive.
                </p>
              ) : filteredFolders.length === 0 ? (
                <p className="text-muted-foreground py-4 text-center text-xs">
                  {search
                    ? `No folders match "${search}"`
                    : "No folders in this Drive"}
                </p>
              ) : (
                filteredFolders.map((folder) => (
                  <FolderRow
                    key={folder.id}
                    connectionId={connectionId}
                    folder={folder}
                    trail={[]}
                    depth={0}
                    selectedChains={selectedChains}
                    selectedSet={selectedSet}
                    withinOrgBoundary={withinOrgBoundary}
                    toggleChain={toggleChain}
                  />
                ))
              )}
            </div>

            {selectedChains.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-muted-foreground text-xs">
                  <span className="text-foreground font-medium">
                    {selectedChains.length}
                  </span>{" "}
                  {selectedChains.length === 1 ? "folder" : "folders"} selected
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {selectedChains.map((chain) => {
                    const label = chainLabel(chain);
                    return (
                      <Badge
                        key={chain}
                        variant="secondary"
                        className="max-w-full gap-1 py-1 pr-1 pl-2 font-normal"
                      >
                        <Folder className="size-3 shrink-0" />
                        <span className="truncate" title={label}>
                          {label}
                        </span>
                        <button
                          type="button"
                          onClick={() => toggleChain(chain)}
                          aria-label={`Remove ${label}`}
                          className="text-muted-foreground hover:bg-foreground/10 hover:text-foreground -mr-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm transition-colors"
                        >
                          <X className="size-3" />
                        </button>
                      </Badge>
                    );
                  })}
                </div>
                <p className="text-muted-foreground text-[11px]">
                  Agents can list a folder only by its ID (
                  <code>&apos;folderId&apos; in parents</code>) and must create
                  files inside one of these folders.
                </p>
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
