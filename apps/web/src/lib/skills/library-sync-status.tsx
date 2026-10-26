"use client";

import {
  AlertTriangle,
  CircleArrowUp,
  Check,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { formatRelative } from "@onecli/api/lib/format";
import type { LibrarySkill } from "@/lib/api";
import { useResyncLibrarySkill } from "@/hooks/use-skill-library";

export interface LibrarySyncStatusProps {
  skill: LibrarySkill;
}

/**
 * Is this skill the same as in the repo? One line + a Re-sync button that
 * pulls it from GitHub now (checks the branch head first). The stored skill
 * is shared, so a Re-sync updates every agent that uses it; the button says
 * so when that's more than this one.
 */
export const LibrarySyncStatus = ({ skill }: LibrarySyncStatusProps) => {
  const resync = useResyncLibrarySkill();
  const busy = resync.isPending && resync.variables === skill.name;
  const checked = skill.checkedAt
    ? `checked ${formatRelative(skill.checkedAt)}`
    : null;
  const scope =
    skill.agentCount > 1
      ? `Updates it for all ${skill.agentCount} agents using it`
      : "Pull the latest from GitHub now";

  const label =
    skill.status === "current" ? (
      <span className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
        <Check className="size-3.5 shrink-0" aria-hidden />
        Up to date @ {skill.commitSha.slice(0, 7)}
      </span>
    ) : skill.status === "behind" ? (
      <span className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
        <CircleArrowUp className="size-3.5 shrink-0" aria-hidden />
        Update available: {skill.commitSha.slice(0, 7)} →{" "}
        {skill.repoSha?.slice(0, 7)}
      </span>
    ) : (
      <span
        className="flex max-w-full min-w-0 items-start gap-1 text-amber-700 dark:text-amber-400"
        title={skill.lastError ?? undefined}
      >
        <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
        <span className="line-clamp-3 min-w-0 break-words">
          Kept last version: {skill.lastError}
        </span>
      </span>
    );

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
      {label}
      {checked && <span className="text-muted-foreground">· {checked}</span>}
      <Button
        size="xs"
        variant="ghost"
        disabled={busy}
        aria-label={`Re-sync ${skill.name} from GitHub. ${scope}`}
        title={scope}
        onClick={() =>
          resync.mutate(skill.name, {
            onSuccess: (fresh) =>
              fresh.status === "error"
                ? toast.error(fresh.lastError ?? "Re-sync failed")
                : toast.success(
                    `${skill.name} is up to date @ ${fresh.commitSha.slice(0, 7)}`,
                  ),
            onError: (e: Error) => toast.error(e.message),
          })
        }
      >
        {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        {busy ? "Syncing…" : "Re-sync"}
      </Button>
    </div>
  );
};
