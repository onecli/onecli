"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import { toast } from "sonner";
import {
  ArrowLeft,
  Building2,
  ChevronRight,
  ExternalLink,
  Loader2,
  Plus,
  Search,
  User,
} from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Checkbox } from "@onecli/ui/components/checkbox";
import { Input } from "@onecli/ui/components/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { cn } from "@onecli/ui/lib/utils";
import type { PageScope } from "@/lib/api";
import type { SharedGitHubInstallation } from "@/lib/api/github-app-share";
import {
  useCreateSharedGitHubConnection,
  useGitHubInstallationRepos,
  useSharedGitHubInstallations,
} from "@/hooks/use-github-app-share";

export interface GitHubAppConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pageScope: PageScope;
  /** Runs the normal GitHub install flow (a GitHub org not connected yet). */
  onInstallNew: () => void;
  onConnected: (connectionId: string) => void;
}

const originLabel = (origin: SharedGitHubInstallation["origin"]) => {
  switch (origin) {
    case "organization":
      return "Connected at the organization level";
    case "another_workspace":
      return "Connected in another workspace";
    default:
      return "Connected here";
  }
};

/**
 * Connect GitHub App from any workspace or the org level: reuse an installation
 * already connected anywhere in the org (picking which repos this connection
 * may reach), or install on a new GitHub account.
 */
export const GitHubAppConnectDialog = ({
  open,
  onOpenChange,
  pageScope,
  onInstallNew,
  onConnected,
}: GitHubAppConnectDialogProps) => {
  const [selected, setSelected] = useState<SharedGitHubInstallation | null>(
    null,
  );
  const [mode, setMode] = useState<"all" | "selected">("selected");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  const { data: installations = [], isPending: loadingInstallations } =
    useSharedGitHubInstallations(pageScope, open);
  const {
    data: repoData,
    isPending: loadingRepos,
    error: reposError,
  } = useGitHubInstallationRepos(
    selected?.sourceConnectionId ?? null,
    pageScope,
  );
  const createMutation = useCreateSharedGitHubConnection(pageScope);

  const repos = useMemo(() => repoData?.repos ?? [], [repoData]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? repos.filter((r) => r.toLowerCase().includes(q)) : repos;
  }, [repos, search]);

  const reset = () => {
    setSelected(null);
    setMode("selected");
    setPicked(new Set());
    setSearch("");
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const toggle = (repo: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(repo)) next.delete(repo);
      else next.add(repo);
      return next;
    });

  const allFilteredPicked =
    filtered.length > 0 && filtered.every((r) => picked.has(r));
  const toggleAllFiltered = () =>
    setPicked((prev) => {
      const next = new Set(prev);
      for (const r of filtered) {
        if (allFilteredPicked) next.delete(r);
        else next.add(r);
      }
      return next;
    });

  const canConnect =
    !!selected &&
    (mode === "all" || picked.size > 0) &&
    !createMutation.isPending;

  const handleConnect = () => {
    if (!selected) return;
    createMutation.mutate(
      {
        sourceConnectionId: selected.sourceConnectionId,
        ...(mode === "selected" ? { repositories: [...picked] } : {}),
      },
      {
        onSuccess: (created) => {
          toast.success(
            `${selected.account ?? "GitHub"} connected${
              mode === "selected"
                ? ` with ${picked.size} ${picked.size === 1 ? "repository" : "repositories"}`
                : ""
            }`,
          );
          handleOpenChange(false);
          onConnected(created.id);
        },
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : "Failed to connect"),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="gap-0 overflow-x-hidden p-0 sm:max-w-xl [&>*]:min-w-0">
        <DialogHeader className="border-border/50 border-b px-5 py-4">
          <DialogTitle className="flex min-w-0 items-center gap-2 pr-6 text-base">
            {selected && (
              <Button
                variant="ghost"
                size="icon"
                className="-ml-2 size-7"
                onClick={() => {
                  setSelected(null);
                  setPicked(new Set());
                  setSearch("");
                }}
                aria-label="Back to installations"
              >
                <ArrowLeft className="size-4" />
              </Button>
            )}
            <span className="truncate">
              {selected
                ? `Choose repositories from ${selected.account ?? "this account"}`
                : "Connect GitHub App"}
            </span>
          </DialogTitle>
          <DialogDescription className="text-xs">
            {selected
              ? "This connection only reaches the repositories you pick here."
              : "Use a GitHub account already connected in your organization, or install on a new one."}
          </DialogDescription>
        </DialogHeader>

        {!selected ? (
          <div className="space-y-2 px-5 py-4">
            {loadingInstallations ? (
              <div className="flex justify-center py-6">
                <Loader2 className="text-muted-foreground size-5 animate-spin" />
              </div>
            ) : (
              <>
                {installations.length > 0 && (
                  <p className="text-muted-foreground text-xs font-medium">
                    Already connected in your organization
                  </p>
                )}
                {installations.map((inst) => (
                  <button
                    key={inst.sourceConnectionId}
                    type="button"
                    onClick={() => {
                      setSelected(inst);
                      setMode("selected");
                    }}
                    className="hover:bg-muted/50 focus-visible:ring-ring flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
                  >
                    {inst.avatarUrl ? (
                      <Image
                        src={inst.avatarUrl}
                        alt=""
                        width={28}
                        height={28}
                        unoptimized
                        className="size-7 shrink-0 rounded-full"
                      />
                    ) : (
                      <div className="bg-muted flex size-7 shrink-0 items-center justify-center rounded-full">
                        {inst.accountType === "Organization" ? (
                          <Building2 className="text-muted-foreground size-3.5" />
                        ) : (
                          <User className="text-muted-foreground size-3.5" />
                        )}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {inst.account ?? "GitHub account"}
                      </p>
                      <p className="text-muted-foreground truncate text-xs">
                        {originLabel(inst.origin)}
                        {inst.repositorySelection === "all"
                          ? " · All repositories"
                          : " · Selected repositories"}
                        {inst.connectedHere > 0 &&
                          inst.origin !== "this_scope" &&
                          ` · ${inst.connectedHere} here already`}
                      </p>
                    </div>
                    <ChevronRight className="text-muted-foreground size-4 shrink-0" />
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    handleOpenChange(false);
                    onInstallNew();
                  }}
                  className="hover:bg-muted/50 focus-visible:ring-ring flex w-full items-center gap-3 rounded-lg border border-dashed px-3 py-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
                >
                  <div className="bg-muted flex size-7 shrink-0 items-center justify-center rounded-full">
                    <Plus className="text-muted-foreground size-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      Install on another GitHub account
                    </p>
                    <p className="text-muted-foreground text-xs">
                      Opens GitHub to install the app
                    </p>
                  </div>
                  <ExternalLink className="text-muted-foreground size-3.5 shrink-0" />
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="px-5 py-4">
            <div className="bg-muted inline-flex w-fit rounded-lg p-0.5">
              {(["selected", "all"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMode(value)}
                  className={cn(
                    "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                    mode === value
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {value === "all"
                    ? "All repositories"
                    : "Selected repositories"}
                </button>
              ))}
            </div>

            {mode === "all" ? (
              <p className="text-muted-foreground mt-3 text-xs">
                Every repository this installation covers, including ones the
                GitHub org owner adds later.
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                {loadingRepos ? (
                  <div className="flex justify-center py-6">
                    <Loader2 className="text-muted-foreground size-5 animate-spin" />
                  </div>
                ) : reposError ? (
                  <p className="text-destructive py-2 text-xs">
                    {reposError instanceof Error
                      ? reposError.message
                      : "Couldn't load repositories"}
                  </p>
                ) : (
                  <>
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
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-muted-foreground text-xs">
                        <span className="text-foreground font-medium">
                          {picked.size}
                        </span>{" "}
                        of {repos.length} selected
                        {repoData?.truncated && " (showing the first 1000)"}
                      </p>
                    </div>
                    <p className="text-muted-foreground text-[11px]">
                      Missing a repository? A GitHub owner of{" "}
                      {selected.account ?? "this account"} has to add it to the
                      app&apos;s installation on GitHub first.
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {selected && (
          <DialogFooter className="border-border/50 border-t px-5 py-3">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleConnect}
              disabled={!canConnect}
              loading={createMutation.isPending}
            >
              {createMutation.isPending ? "Connecting..." : "Connect"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
};
