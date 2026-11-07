"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import type { PageScope } from "@/lib/api";
import {
  useGitHubConnectionRepos,
  useSetGitHubConnectionRepos,
} from "@/hooks/use-github-app-share";
import { RepoScopePicker, type RepoScopeMode } from "./repo-scope-picker";

export interface EditRepositoriesDialogProps {
  connectionId: string;
  account: string;
  /** The installation's settings page on GitHub (the connection's metadata). */
  manageUrl?: string | null;
  pageScope: PageScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Change which repositories a connected GitHub account reaches, without
 * disconnecting: every repo the installation covers, or a picked subset.
 * Agents that use the connection keep it. Opening it reads the installation
 * live (which also refreshes the connection's stored list), and so does
 * coming back from "Manage on GitHub".
 */
export const EditRepositoriesDialog = ({
  connectionId,
  account,
  manageUrl,
  pageScope,
  open,
  onOpenChange,
}: EditRepositoriesDialogProps) => {
  const repos = useGitHubConnectionRepos(connectionId, pageScope, open);
  const save = useSetGitHubConnectionRepos(pageScope);
  // null = not touched yet: show the connection's current choice.
  const [mode, setMode] = useState<RepoScopeMode | null>(null);
  const [picked, setPicked] = useState<Set<string> | null>(null);

  const current = repos.data?.selected ?? null;
  const shownMode: RepoScopeMode = mode ?? (current ? "selected" : "all");
  const availableByName = new Map(
    (repos.data?.available ?? []).map((repo) => [repo.toLowerCase(), repo]),
  );
  const shownPicked = new Set(
    [...(picked ?? new Set(current ?? []))].map(
      (repo) => availableByName.get(repo.toLowerCase()) ?? repo,
    ),
  );

  const missingPicked = [...shownPicked].filter(
    (repo) => !repos.data?.available.includes(repo),
  );
  const canSave =
    !!repos.data &&
    !repos.isFetching &&
    !repos.isError &&
    !save.isPending &&
    (shownMode === "all" ||
      (shownPicked.size > 0 &&
        shownPicked.size <= 500 &&
        missingPicked.length === 0));

  const close = (next: boolean) => {
    if (!next) {
      setMode(null);
      setPicked(null);
    }
    onOpenChange(next);
  };

  const submit = () => {
    if (!canSave) return;
    save.mutate(
      {
        connectionId,
        repositories: shownMode === "all" ? null : [...shownPicked],
      },
      {
        onSuccess: () => {
          toast.success(
            shownMode === "all"
              ? `${account} reaches every repository`
              : `${account} reaches ${shownPicked.size} ${shownPicked.size === 1 ? "repository" : "repositories"}`,
          );
          close(false);
        },
        onError: (e: Error) => toast.error(e.message),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="gap-0 overflow-x-hidden p-0 sm:max-w-xl [&>*]:min-w-0">
        <DialogHeader className="border-border/50 border-b px-5 py-4">
          <DialogTitle className="text-base">
            Repositories for {account}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Which repositories this connection reaches. Agents that use it keep
            it.
          </DialogDescription>
        </DialogHeader>
        <div className="px-5 py-4">
          <RepoScopePicker
            mode={shownMode}
            onModeChange={setMode}
            repos={repos.data?.available ?? []}
            picked={shownPicked}
            onPickedChange={setPicked}
            loading={repos.isFetching || repos.isPending}
            error={repos.error}
            truncated={repos.data?.truncated}
            account={account}
            manageUrl={manageUrl}
            onReload={() => void repos.refetch()}
          />
        </div>
        <DialogFooter className="border-border/50 border-t px-5 py-3">
          <Button size="sm" variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={!canSave}
            loading={save.isPending}
          >
            {save.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
