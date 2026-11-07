"use client";

import { useState } from "react";
import { ExternalLink, Loader2, MoreHorizontal, Trash2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import { Switch } from "@onecli/ui/components/switch";
import type { LibrarySkill } from "@/lib/api";
import { githubTreeUrl } from "./github-urls";
import { LibrarySyncStatus } from "./library-sync-status";
import { RemoveLibrarySkillDialog } from "./remove-library-skill-dialog";
import { SkillSourceChip } from "./skill-source-chip";

export interface LibrarySkillRowProps {
  skill: LibrarySkill;
  repo: string | null;
  /** Present = this row can be removed here (attached to this agent),
   * after a confirm. */
  onRemove?: () => void;
  removing?: boolean;
  /** Present = the agent's on/off switch (same as a regular skill's):
   * instant, so it is never disabled while it saves. */
  onToggle?: (next: boolean) => void;
}

/** One read-only library skill: the repo is its source of truth. */
export const LibrarySkillRow = ({
  skill,
  repo,
  onRemove,
  removing,
  onToggle,
}: LibrarySkillRowProps) => {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const githubUrl = repo
    ? githubTreeUrl(repo, skill.commitSha, skill.path)
    : null;
  const notes = [
    skill.plugin,
    `${skill.fileCount} file${skill.fileCount === 1 ? "" : "s"}`,
    skill.agentCount > 0 &&
      `used by ${skill.agentCount} agent${skill.agentCount === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return (
    <div className="flex items-center gap-3 p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-mono text-sm font-medium">
            {skill.name}
          </span>
          <SkillSourceChip kind="library" />
        </div>
        <p
          className="text-muted-foreground mt-0.5 truncate text-sm"
          title={skill.description}
        >
          {skill.description}
        </p>
        <p className="text-muted-foreground/80 mt-0.5 text-xs">
          {notes.join(" · ")}
        </p>
        <LibrarySyncStatus skill={skill} />
        {skill.skipped.length > 0 && (
          <details className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">
            <summary className="cursor-pointer select-none">
              {skill.skipped.length} file
              {skill.skipped.length === 1 ? "" : "s"} left out
            </summary>
            <ul className="text-muted-foreground mt-1 space-y-0.5">
              {skill.skipped.map((s) => (
                <li key={s.path}>
                  <span className="font-mono">{s.path}</span>: {s.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      {githubUrl && (
        <Button
          asChild
          variant="ghost"
          size="icon-xs"
          aria-label={`View ${skill.name} on GitHub`}
        >
          <a href={githubUrl} target="_blank" rel="noreferrer">
            <ExternalLink className="size-4" />
          </a>
        </Button>
      )}
      {onToggle && (
        <Switch
          size="sm"
          checked={skill.enabled ?? true}
          aria-label={`${(skill.enabled ?? true) ? "Pause" : "Resume"} ${skill.name}`}
          onCheckedChange={onToggle}
        />
      )}
      {onRemove && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Options for ${skill.name}`}
              disabled={removing}
            >
              {removing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <MoreHorizontal className="size-4" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setConfirmRemove(true)}
            >
              <Trash2 className="size-4" />
              Remove from this agent
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {onRemove && (
        <RemoveLibrarySkillDialog
          open={confirmRemove}
          onOpenChange={setConfirmRemove}
          name={skill.name}
          onConfirm={onRemove}
        />
      )}
    </div>
  );
};
