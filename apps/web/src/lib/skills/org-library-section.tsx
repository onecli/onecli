"use client";

import { useState } from "react";
import { Library, Loader2, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import { Card } from "@onecli/ui/components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { formatRelative } from "@onecli/api/lib/format";
import { queryKeys } from "@/lib/api/keys";
import {
  useDisconnectSkillLibrary,
  useOrgRepoSkills,
  useOrgSkillLibrary,
} from "@/hooks/use-skill-library";
import { ConnectLibraryDialog } from "./connect-library-dialog";
import { DisconnectLibraryDialog } from "./disconnect-library-dialog";
import { GitHubMark } from "./github-mark";
import { githubTreeUrl } from "./github-urls";
import { LibraryPickerDialog } from "./library-picker-dialog";
import { LoadFailed } from "./load-failed";

/**
 * The org's GitHub library: one integration card
 * (connect / status / preview / change / disconnect). Agents add and switch
 * library skills on their own Skills page.
 */
export const OrgLibrarySection = () => {
  const library = useOrgSkillLibrary();
  const disconnect = useDisconnectSkillLibrary();
  const queryClient = useQueryClient();
  // The live repo listing (cached per commit), for the "N skills found" count.
  // Not read while access is lost: it can only fail then.
  const repoSkills = useOrgRepoSkills(
    !!library.data?.source && !library.data.source.accessLost,
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  // A confirm that names what is lost reads it fresh: another admin may have
  // added skills to agents since this page loaded.
  const refreshImpact = () =>
    void queryClient.invalidateQueries({
      queryKey: queryKeys.skills.library(),
      exact: true,
    });

  if (library.isPending) {
    return (
      <section className="pt-4" aria-busy="true">
        <Skeleton className="h-[74px] w-full rounded-xl" />
        <span className="sr-only">Loading the GitHub skill library</span>
      </section>
    );
  }
  if (library.isError) {
    return (
      <section className="pt-4">
        <LoadFailed
          message="Couldn't load the GitHub skill library."
          onRetry={() => void library.refetch()}
        />
      </section>
    );
  }
  const { source, usage, skillsOnlyInstall } = library.data;
  const accessLost = !!source?.accessLost;
  const skillCount = repoSkills.data
    ? repoSkills.data.skills.filter((s) => !s.problem).length
    : null;
  const issueCount = repoSkills.data
    ? repoSkills.data.skills.filter((s) => s.problem).length
    : 0;

  return (
    <section className="space-y-3 pt-4">
      <Card className="flex flex-row items-center gap-4 p-4">
        <div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-md">
          <GitHubMark />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 text-sm font-medium">GitHub skill library</p>
            {source && (
              <Badge
                variant="outline"
                className={
                  source.lastError || accessLost
                    ? "border-amber-300 text-amber-700 dark:text-amber-400"
                    : "border-emerald-300 text-emerald-700 dark:text-emerald-400"
                }
              >
                {accessLost
                  ? "Access lost"
                  : source.lastError
                    ? "Needs attention"
                    : "Connected"}
              </Badge>
            )}
            {source && !accessLost && skillCount !== null && (
              <Badge variant="secondary">
                {skillCount} skill{skillCount === 1 ? "" : "s"} found
              </Badge>
            )}
            {source && !accessLost && issueCount > 0 && (
              <Badge
                variant="outline"
                className="border-amber-300 text-amber-700 dark:text-amber-400"
              >
                {issueCount} can&apos;t be used
              </Badge>
            )}
          </div>
          {source ? (
            <>
              <p className="text-muted-foreground truncate text-xs">
                <a
                  href={githubTreeUrl(source.repo, source.branch)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground font-mono hover:underline"
                >
                  {source.repo}
                </a>
                {" · "}
                {source.branch}
                {!source.lastError && source.lastSyncedAt
                  ? ` · synced ${formatRelative(source.lastSyncedAt)}`
                  : ""}
              </p>
              {source.lastError && (
                <p className="mt-0.5 text-xs break-words text-amber-700 dark:text-amber-400">
                  {source.lastError}
                </p>
              )}
            </>
          ) : (
            <p className="text-muted-foreground text-xs">
              Use the skills your team keeps in a GitHub repo, such as a Claude
              Code marketplace or any folder with SKILL.md.
            </p>
          )}
        </div>
        {(!source || accessLost) && (
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            {source ? "Reconnect" : "Connect"}
          </Button>
        )}
        {source && !accessLost && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPickerOpen(true)}
          >
            <Library className="size-4" />
            Preview library
          </Button>
        )}
        {source && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                aria-label="Library options"
              >
                {disconnect.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <MoreHorizontal className="size-4" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {!accessLost && (
                <DropdownMenuItem onSelect={() => setDialogOpen(true)}>
                  Change repo
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => {
                  refreshImpact();
                  setDisconnectOpen(true);
                }}
              >
                Disconnect…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </Card>
      {source && !accessLost && repoSkills.isError && (
        <LoadFailed
          message={`Couldn't read ${source.repo}: ${repoSkills.error.message}`}
          onRetry={() => void repoSkills.refetch()}
        />
      )}
      <ConnectLibraryDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        current={source}
        usage={usage}
        skillsOnlyInstall={skillsOnlyInstall}
      />
      {source && (
        <>
          <LibraryPickerDialog open={pickerOpen} onOpenChange={setPickerOpen} />
          <DisconnectLibraryDialog
            open={disconnectOpen}
            onOpenChange={setDisconnectOpen}
            repo={source.repo}
            usage={usage}
            busy={disconnect.isPending}
            onConfirm={() =>
              disconnect.mutate(undefined, {
                onSuccess: () => {
                  setDisconnectOpen(false);
                  toast.success("Library disconnected");
                },
                onError: (e: Error) => toast.error(e.message),
              })
            }
          />
        </>
      )}
    </section>
  );
};
