"use client";

import { useState } from "react";
import { ChevronRight, Folder, HardDrive, Loader2 } from "lucide-react";
import { Checkbox } from "@onecli/ui/components/checkbox";
import { cn } from "@onecli/ui/lib/utils";
import { coveredBy } from "@onecli/api/lib/resource-axis";
import type { GoogleDriveFolder } from "@/lib/api/types";
import { useGoogleDriveFolders } from "./use-google-drive-folders";

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** "3 folders · 12 files" — null when the server couldn't count. A capped count
 * covered only the first page of children, so it is shown as a lower bound. */
export const childSummary = (
  folder: Pick<
    GoogleDriveFolder,
    "subfolderCount" | "fileCount" | "countCapped"
  >,
): string | null => {
  const { subfolderCount: dirs, fileCount: files, countCapped } = folder;
  if (dirs === null || files === null) return null;
  if (countCapped) return `${dirs + files}+ items`;
  if (dirs === 0 && files === 0) return "Empty";
  return [
    dirs > 0 ? plural(dirs, "folder", "folders") : null,
    files > 0 ? plural(files, "file", "files") : null,
  ]
    .filter(Boolean)
    .join(" · ");
};

/** One folder on the path from the top of a drive to a row. */
export interface FolderCrumb {
  id: string;
  name: string;
}

export interface FolderRowProps {
  connectionId: string;
  folder: GoogleDriveFolder;
  /** The ancestors browsed to reach this folder, top first. */
  trail: FolderCrumb[];
  depth: number;
  selectedChains: string[];
  selectedSet: Set<string>;
  withinOrgBoundary: (chain: string) => boolean;
  toggleChain: (chain: string, trail?: FolderCrumb[]) => void;
}

/** Deepest level the tree opens to: Drive's own nesting limit, which is also
 * the longest chain the server and gateway accept. */
const MAX_DEPTH = 100;

/**
 * One folder in the tree. Expanding it lazily lists ITS subfolders (each with
 * its own counts), so the user can keep opening until a folder has none —
 * those rows show no arrow, only what they hold.
 */
export const FolderRow = ({
  connectionId,
  folder,
  trail,
  depth,
  selectedChains,
  selectedSet,
  withinOrgBoundary,
  toggleChain,
}: FolderRowProps) => {
  const [open, setOpen] = useState(false);
  const ownTrail = [...trail, { id: folder.id, name: folder.name }];
  const chain = ownTrail.map((c) => c.id).join("/");
  // Unknown count (null) stays expandable — the listing answers it — and so
  // does a capped one: its subfolders may sit beyond the counted first page.
  const hasChildren =
    (folder.subfolderCount !== 0 || folder.countCapped) && depth < MAX_DEPTH;
  const {
    data: children = [],
    isPending,
    isError,
  } = useGoogleDriveFolders(connectionId, folder.id, open && hasChildren);
  const directlySelected = selectedSet.has(chain);
  const covered =
    !directlySelected &&
    selectedChains.length > 0 &&
    coveredBy(chain, { driveFolders: selectedChains });
  const outside = !withinOrgBoundary(chain);
  // Only the CHECK direction is barred: a folder selected before the
  // organization narrowed its boundary must stay removable.
  const lockedOut = covered || (outside && !directlySelected);
  const Icon = folder.kind === "sharedDrive" ? HardDrive : Folder;
  const summary = childSummary(folder);
  const toggleOpen = () => hasChildren && setOpen((o) => !o);

  return (
    <div>
      <div
        className="hover:bg-muted/50 flex items-center gap-1.5 rounded-sm py-1.5 pr-2"
        style={{ paddingLeft: `${0.25 + depth * 1.1}rem` }}
      >
        <button
          type="button"
          onClick={toggleOpen}
          disabled={!hasChildren}
          aria-expanded={hasChildren ? open : undefined}
          aria-label={
            hasChildren
              ? `${open ? "Collapse" : "Expand"} ${folder.name}`
              : undefined
          }
          className={cn(
            "text-muted-foreground flex size-4 shrink-0 items-center justify-center rounded-sm",
            hasChildren ? "hover:bg-foreground/10" : "invisible",
          )}
        >
          <ChevronRight
            className={cn("size-3.5 transition-transform", open && "rotate-90")}
          />
        </button>
        <Checkbox
          checked={directlySelected || covered}
          disabled={lockedOut}
          onCheckedChange={() => toggleChain(chain, ownTrail)}
          aria-label={folder.name}
          className={cn("size-3.5", lockedOut && "opacity-50")}
        />
        {/* The name is a second, larger toggle; on a leaf it does nothing,
            so it leaves the tab order there. */}
        <button
          type="button"
          onClick={toggleOpen}
          disabled={!hasChildren}
          aria-expanded={hasChildren ? open : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Icon className="text-muted-foreground size-3.5 shrink-0" />
          <span className={cn("truncate text-xs", lockedOut && "opacity-50")}>
            {folder.name}
          </span>
          {folder.kind === "sharedDrive" && (
            <span className="text-muted-foreground shrink-0 text-[11px]">
              Shared drive
            </span>
          )}
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
          {summary && (
            <span className="text-muted-foreground ml-auto shrink-0 pl-2 text-[11px] tabular-nums">
              {summary}
            </span>
          )}
        </button>
      </div>
      {open && hasChildren && (
        <div>
          {isPending ? (
            <div
              className="flex items-center py-1.5"
              style={{ paddingLeft: `${1.6 + (depth + 1) * 1.1}rem` }}
            >
              <Loader2 className="text-muted-foreground size-3.5 animate-spin" />
            </div>
          ) : isError ? (
            <p
              className="text-muted-foreground py-1.5 text-[11px]"
              style={{ paddingLeft: `${1.6 + (depth + 1) * 1.1}rem` }}
            >
              Couldn&rsquo;t load subfolders.
            </p>
          ) : children.length === 0 ? (
            <p
              className="text-muted-foreground py-1.5 text-[11px]"
              style={{ paddingLeft: `${1.6 + (depth + 1) * 1.1}rem` }}
            >
              No subfolders
            </p>
          ) : (
            children.map((child) => (
              <FolderRow
                key={child.id}
                connectionId={connectionId}
                folder={child}
                trail={ownTrail}
                depth={depth + 1}
                selectedChains={selectedChains}
                selectedSet={selectedSet}
                withinOrgBoundary={withinOrgBoundary}
                toggleChain={toggleChain}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
};
