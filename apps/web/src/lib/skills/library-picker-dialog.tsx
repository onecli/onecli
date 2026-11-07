"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Loader2,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Input } from "@onecli/ui/components/input";
import { cn } from "@onecli/ui/lib/utils";
import type { RepoSkill } from "@/lib/api";
import {
  useAgentAvailableLibrarySkills,
  useAttachLibrarySkills,
  useOrgRepoSkills,
} from "@/hooks/use-skill-library";
import { RepoSkillProblem } from "./repo-skill-problem";
import { githubTreeUrl } from "./github-urls";

export interface LibraryPickerDialogProps {
  /** The agent to add to. Omitted = the org's read-only preview. */
  agentId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const NO_PLUGIN = "Other skills";

/**
 * "Add from library": the connected repo, listed live from GitHub and grouped
 * by plugin. On an agent, adding fetches that skill's folder and adds it to
 * that agent only; from then on it follows the repo. At the org it is a
 * read-only preview (agents add skills from their own page). Skills that
 * can't be used say why, and "Show issues" lists just those.
 */
export const LibraryPickerDialog = ({
  agentId,
  open,
  onOpenChange,
}: LibraryPickerDialogProps) => {
  const isOrg = !agentId;
  const agentListing = useAgentAvailableLibrarySkills(
    agentId ?? "",
    open && !isOrg,
  );
  const orgListing = useOrgRepoSkills(open && isOrg);
  const listing = isOrg ? orgListing : agentListing;
  const attach = useAttachLibrarySkills(agentId ?? "");
  const [query, setQuery] = useState("");
  const [issuesOnly, setIssuesOnly] = useState(false);
  // The run in flight: which names, and how many are done.
  const [run, setRun] = useState<{ names: string[]; done: number } | null>(
    null,
  );

  const all = useMemo(() => listing.data?.skills ?? [], [listing.data]);
  const issueCount = all.filter((s) => s.problem).length;
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const skills = all.filter(
      (s) =>
        (!issuesOnly || s.problem) &&
        (q === "" ||
          s.name.toLowerCase().includes(q) ||
          s.path.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          (s.plugin ?? "").toLowerCase().includes(q)),
    );
    const byPlugin = new Map<string, RepoSkill[]>();
    for (const skill of skills) {
      const key = skill.plugin ?? NO_PLUGIN;
      byPlugin.set(key, [...(byPlugin.get(key) ?? []), skill]);
    }
    return [...byPlugin.entries()].sort(([a], [b]) =>
      a === NO_PLUGIN ? 1 : b === NO_PLUGIN ? -1 : a.localeCompare(b),
    );
  }, [all, query, issuesOnly]);

  const folderUrl = (path: string) =>
    listing.data
      ? githubTreeUrl(listing.data.repo, listing.data.commitSha, path)
      : "#";

  const add = (names: string[]) => {
    if (isOrg || names.length === 0) return;
    setRun({ names, done: 0 });
    attach.mutate(
      {
        names,
        onProgress: (done) => setRun({ names, done }),
      },
      {
        onSuccess: () =>
          toast.success(
            names.length > 1
              ? `Added ${names.length} skills`
              : `Added ${names[0]}`,
          ),
        onError: (error: Error) => toast.error(error.message),
        onSettled: () => setRun(null),
      },
    );
  };
  const busy = run !== null;
  const adding = (name: string) =>
    busy && run.names[Math.min(run.done, run.names.length - 1)] === name;

  // An add run in flight keeps the picker open (closing would hide its
  // progress and its outcome). Closing starts the next visit fresh.
  const changeOpen = (next: boolean) => {
    if (!next && busy) return;
    if (!next) {
      setQuery("");
      setIssuesOnly(false);
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        className="flex max-h-[85vh] flex-col sm:max-w-2xl"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>
            {isOrg ? "Library preview" : "Add from library"}
          </DialogTitle>
          <DialogDescription>
            {isOrg && "Agents add these from their own Skills page. "}
            {listing.data
              ? `${listing.data.repo} @ ${listing.data.commitSha.slice(0, 7)} · read-only, follows the repo`
              : "Skills from your organization's GitHub repo"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search skills"
              className="pl-8"
              aria-label="Search library skills"
            />
          </div>
          {issueCount > 0 && (
            <Button
              size="sm"
              variant={issuesOnly ? "secondary" : "outline"}
              aria-pressed={issuesOnly}
              onClick={() => setIssuesOnly((v) => !v)}
              className={cn(
                !issuesOnly && "text-amber-700 dark:text-amber-400",
              )}
            >
              <AlertTriangle className="size-4" />
              {issuesOnly ? "Show all" : `Show issues (${issueCount})`}
            </Button>
          )}
        </div>

        {listing.data?.truncated && (
          <p className="text-muted-foreground text-xs">
            This repo is very large, so some skills may be missing here.
          </p>
        )}
        {busy && run.names.length > 1 && (
          <p role="status" className="text-muted-foreground text-xs">
            Adding {Math.min(run.done + 1, run.names.length)} of{" "}
            {run.names.length}…
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {listing.isPending ? (
            <div className="flex justify-center py-10">
              <Loader2 className="text-muted-foreground size-5 animate-spin" />
              <span className="sr-only">Loading the repo</span>
            </div>
          ) : listing.isError ? (
            <div role="alert" className="space-y-2 py-6 text-sm">
              <p className="text-destructive">{listing.error.message}</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void listing.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : groups.length === 0 ? (
            <p className="text-muted-foreground py-6 text-center text-sm">
              {all.length === 0
                ? "No skills found in this repo. A skill is a folder with a SKILL.md."
                : "No skills match."}
            </p>
          ) : (
            groups.map(([plugin, skills]) => {
              const addable = isOrg
                ? []
                : skills
                    .filter((s) => !s.added && !s.problem)
                    .map((s) => s.name);
              return (
                <section key={plugin} className="mb-4">
                  <div className="mb-1 flex items-center gap-2">
                    <h3 className="text-sm font-semibold">{plugin}</h3>
                    <Badge variant="secondary">{skills.length}</Badge>
                    <span className="flex-1" />
                    {plugin !== NO_PLUGIN && addable.length > 1 && (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => add(addable)}
                      >
                        Add all ({addable.length})
                      </Button>
                    )}
                  </div>
                  <div className="divide-y rounded-md border">
                    {skills.map((skill) => (
                      <div
                        key={skill.path}
                        className="flex items-start gap-3 p-3"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-mono text-sm font-medium">
                            {skill.name}
                          </p>
                          {skill.problem ? (
                            <RepoSkillProblem
                              skill={skill}
                              folderUrl={folderUrl}
                            />
                          ) : (
                            <p
                              className="text-muted-foreground truncate text-sm"
                              title={skill.description}
                            >
                              {skill.description}
                            </p>
                          )}
                        </div>
                        {listing.data && (
                          <Button
                            asChild
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`View ${skill.name} on GitHub`}
                          >
                            <a
                              href={folderUrl(skill.path)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <ExternalLink className="size-4" />
                            </a>
                          </Button>
                        )}
                        {isOrg || skill.problem ? null : skill.added ? (
                          <span className="flex items-center gap-1 text-sm text-emerald-700 dark:text-emerald-400">
                            <Check className="size-4" /> Added
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            disabled={busy}
                            aria-label={`Add ${skill.name}`}
                            onClick={() => add([skill.name])}
                          >
                            {adding(skill.name) ? (
                              <>
                                <Loader2 className="size-4 animate-spin" />
                                Adding…
                              </>
                            ) : (
                              "Add"
                            )}
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
