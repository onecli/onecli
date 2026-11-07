"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import { DialogFooter } from "@onecli/ui/components/dialog";
import { Input } from "@onecli/ui/components/input";
import { Label } from "@onecli/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import type { LibraryUsage, SkillSource } from "@/lib/api";
import {
  LibrarySwitchConflict,
  type LibraryAccess,
} from "@/lib/api/skill-library";
import {
  useConnectSkillLibrary,
  useLibraryAccessRepos,
  useLibraryGitHubAccounts,
} from "@/hooks/use-skill-library";
import { GITHUB_POPUP, openCenteredPopup } from "@/lib/connect-popup";
import { openLibraryGrantPopup } from "@/lib/skills/library-grant-popup";
import { queryKeys } from "@/lib/api/keys";
import { githubInstallationUrl } from "./github-urls";
import { LibraryAccessEmpty } from "./library-access-empty";
import { LoadFailed } from "./load-failed";
import { SwitchLibraryDialog } from "./switch-library-dialog";

export interface ConnectLibraryFormProps {
  current: SkillSource | null;
  /** What the current library is used for: a switch away from it asks first. */
  usage: LibraryUsage | null;
  /** "Install GitHub for skills only" is available on this deployment. */
  skillsOnlyInstall: boolean;
  onDone: () => void;
}

/** The "GitHub access" picker's value: an org connection's id, the
 * library's current access, or a fresh skills-only install. */
const CURRENT = "current";
const SKILLS_ONLY = "skills-only";
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Calls `onBack` once, when this window next regains focus (back from a
 * GitHub window). Returns a cleanup. */
const onceBack = (onBack: () => void) => {
  const listener = () => {
    window.removeEventListener("focus", listener);
    onBack();
  };
  window.addEventListener("focus", listener);
  return () => window.removeEventListener("focus", listener);
};

/**
 * The connect dialog's body: which GitHub access the library uses, then the
 * repo and branch. The access is a GitHub account the ORG already connected
 * (reused, nothing new under Connections), or "Install GitHub for skills
 * only" (a popup install that creates NO org connection, offered only where
 * the server allows it). The server verifies the branch is readable, then
 * keeps its own copy of the access.
 *
 * A library that lost its access is reconnected here: its current access is
 * not offered (it can't read the repo any more).
 *
 * Switching an existing library to another repo or branch removes the
 * skills agents use from it, so that asks first (the server insists too).
 */
export const ConnectLibraryForm = ({
  current,
  usage,
  skillsOnlyInstall,
  onDone,
}: ConnectLibraryFormProps) => {
  const installations = useLibraryGitHubAccounts();
  const orgId = useParams<{ orgId?: string }>()?.orgId ?? "";
  const queryClient = useQueryClient();
  // The grant is for this org: never ask for one without an org id.
  const canInstall = skillsOnlyInstall && orgId !== "";
  // The library's own access, while it still reads the repo.
  const keepable = !!current && !current.accessLost;

  // A skills-only install's signed grant (this org + this user, ~10 min).
  const [grant, setGrant] = useState<string | null>(null);
  const stopListening = useRef<(() => void) | null>(null);
  const stopWatching = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      stopListening.current?.();
      stopWatching.current?.();
    },
    [],
  );
  const installForSkills = () => {
    if (!canInstall) return;
    stopListening.current?.();
    stopListening.current = openLibraryGrantPopup(orgId, (signed) => {
      stopListening.current = null;
      setGrant(signed);
      setRepo("");
      setChoice(SKILLS_ONLY);
    });
    if (!stopListening.current) {
      toast.error(
        "Your browser blocked the GitHub window. Allow popups and try again.",
      );
    }
  };

  // The org-level GitHub accounts (the server lists only those: a
  // workspace's install is that workspace's business, not the library's).
  const list = useMemo(() => installations.data ?? [], [installations.data]);
  // Changing a working library defaults to its own access (no new install,
  // no org connection needed). A first connect or a reconnect defaults to
  // the only org account when there is exactly one.
  const [picked, setChoice] = useState<string>(keepable ? CURRENT : "");
  const choice =
    picked || (list.length === 1 ? (list[0]?.appConnectionId ?? "") : "");
  const access = useMemo<LibraryAccess | null>(
    () =>
      choice === CURRENT
        ? {}
        : choice === SKILLS_ONLY
          ? grant
            ? { grant }
            : null
          : choice
            ? { appConnectionId: choice }
            : null,
    [choice, grant],
  );
  const repos = useLibraryAccessRepos(access);
  const [repo, setRepo] = useState(current?.repo ?? "");
  const [branch, setBranch] = useState(current?.branch ?? "main");
  const connect = useConnectSkillLibrary();
  // A switch to confirm: the impact the server sent with its refusal, or
  // null for the library's own (refetched as the confirm opens).
  const [confirm, setConfirm] = useState<{
    refused: LibraryUsage | null;
  } | null>(null);
  const openConfirm = (refused: LibraryUsage | null) => {
    setConfirm({ refused });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.skills.library(),
      exact: true,
    });
  };

  // The installation the picked access reaches (the server says), for
  // "Add it on GitHub".
  const installation = repos.data?.installation ?? null;
  const manageReposUrl = installation
    ? githubInstallationUrl(installation)
    : null;

  // GitHub's settings page is a desktop layout: give it room (~1024px). A
  // blocked popup falls back to a new tab. Coming back lists what was just
  // shared: armed here, once, because the query's own refetch on focus
  // follows tab visibility, which a popup closing never changes.
  const openManageRepos = () => {
    if (!manageReposUrl) return;
    const popup = openCenteredPopup(
      manageReposUrl,
      "github-manage-repos",
      GITHUB_POPUP.height,
      GITHUB_POPUP.width,
    );
    if (!popup) window.open(manageReposUrl, "_blank", "noopener");
    stopWatching.current?.();
    stopWatching.current = onceBack(() => {
      stopWatching.current = null;
      void repos.refetch();
    });
  };

  if (installations.isPending) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
        <span className="sr-only">Loading GitHub accounts</span>
      </div>
    );
  }

  if (installations.isError) {
    return (
      <LoadFailed
        message="Couldn't load your organization's GitHub accounts."
        onRetry={() => void installations.refetch()}
      />
    );
  }

  // Nothing to pick from yet.
  if (list.length === 0 && !keepable && !grant) {
    return (
      <LibraryAccessEmpty
        canInstall={canInstall}
        orgId={orgId}
        onInstall={installForSkills}
      />
    );
  }

  const target = { repo: repo.trim(), branch: branch.trim() || "main" };
  const repoChanges = !!current && current.repo !== target.repo;
  const switching =
    !!current && (repoChanges || current.branch !== target.branch);
  const reconnecting = !!current?.accessLost;

  const submit = (replace: boolean) =>
    connect.mutate(
      { ...(access ?? {}), ...target, ...(replace ? { replace } : {}) },
      {
        onSuccess: (source) => {
          setConfirm(null);
          toast.success(
            switching
              ? `Switched to ${repoChanges ? source.repo : source.branch}`
              : reconnecting
                ? "Library reconnected"
                : current
                  ? "Library access updated"
                  : `Connected ${source.repo}`,
          );
          onDone();
        },
        onError: (e: Error) => {
          // The server knows best what a switch takes away: confirm that.
          if (e instanceof LibrarySwitchConflict) openConfirm(e.usage);
          else toast.error(e.message);
        },
      },
    );
  // A switch that would remove skills agents use asks first.
  const onSubmit = () =>
    switching && usage && usage.skillNames.length > 0
      ? openConfirm(null)
      : submit(false);
  const confirmUsage = confirm ? (confirm.refused ?? usage) : null;

  const listed = repos.data?.repos ?? [];
  // Past GitHub's listing cap, a repo may simply not be in the menu.
  const typeRepo = !!repos.data?.truncated;
  // The access reaches no repo at all: say so, with the way to share one.
  const noRepos = !!repos.data && listed.length === 0 && !typeRepo;
  const repoInvalid = target.repo !== "" && !REPO_PATTERN.test(target.repo);
  const addOnGitHub = (label: string) =>
    manageReposUrl && (
      <button
        type="button"
        onClick={openManageRepos}
        className="text-foreground underline-offset-2 hover:underline"
      >
        {label}
      </button>
    );

  return (
    <>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="lib-account">GitHub access</Label>
            {canInstall && (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
                onClick={installForSkills}
              >
                Install GitHub for skills only
              </button>
            )}
          </div>
          <Select
            value={choice}
            onValueChange={(v) => {
              setChoice(v);
              setRepo("");
            }}
          >
            <SelectTrigger id="lib-account" className="w-full">
              <SelectValue placeholder="Pick an account" />
            </SelectTrigger>
            <SelectContent>
              {keepable && current && (
                <SelectItem value={CURRENT}>
                  {current.account ?? "GitHub"} · current
                </SelectItem>
              )}
              {grant && (
                <SelectItem value={SKILLS_ONLY}>
                  New install · skills only
                </SelectItem>
              )}
              {list.map((inst) => (
                <SelectItem
                  key={inst.appConnectionId}
                  value={inst.appConnectionId}
                >
                  {inst.account ?? inst.installationId} · org connection
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-[1fr_8rem] gap-3">
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="lib-repo">Repository</Label>
            {noRepos ? (
              <p className="text-muted-foreground rounded-md border border-dashed px-3 py-2 text-sm">
                No repos shared with OneCLI yet.{" "}
                {addOnGitHub("Add one on GitHub")}
              </p>
            ) : typeRepo ? (
              <Input
                id="lib-repo"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="owner/name"
                list="lib-repo-options"
                className="font-mono"
                spellCheck={false}
                aria-invalid={repoInvalid}
                aria-describedby={repoInvalid ? "lib-repo-hint" : undefined}
              />
            ) : (
              <Select
                value={repo}
                onValueChange={setRepo}
                disabled={!access || repos.isPending || repos.isError}
              >
                <SelectTrigger id="lib-repo" className="w-full">
                  <SelectValue
                    placeholder={
                      access && repos.isPending ? "Loading…" : "Pick a repo"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {listed.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {typeRepo && (
              <datalist id="lib-repo-options">
                {listed.map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
            )}
            {repos.isError ? (
              <p role="alert" className="text-destructive text-xs">
                Couldn&apos;t list repos: {repos.error.message}{" "}
                <button
                  type="button"
                  className="text-foreground underline-offset-2 hover:underline"
                  onClick={() => void repos.refetch()}
                >
                  Retry
                </button>
              </p>
            ) : typeRepo ? (
              repoInvalid ? (
                <p id="lib-repo-hint" className="text-destructive text-xs">
                  Use owner/name
                </p>
              ) : (
                <p className="text-muted-foreground text-xs">
                  This account has more repos than we can list. Type owner/name.
                </p>
              )
            ) : (
              !noRepos &&
              manageReposUrl && (
                <p className="text-muted-foreground text-xs">
                  Repo not listed? {addOnGitHub("Add it on GitHub")}
                </p>
              )
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lib-branch">Branch</Label>
            <Input
              id="lib-branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="font-mono"
              spellCheck={false}
            />
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button
          disabled={
            !access || !REPO_PATTERN.test(target.repo) || connect.isPending
          }
          onClick={onSubmit}
        >
          {connect.isPending && <Loader2 className="size-4 animate-spin" />}
          {connect.isPending
            ? switching
              ? "Switching…"
              : reconnecting
                ? "Reconnecting…"
                : current
                  ? "Saving…"
                  : "Connecting…"
            : switching
              ? repoChanges
                ? "Switch repo…"
                : "Switch branch…"
              : reconnecting
                ? "Reconnect"
                : current
                  ? "Save"
                  : "Connect"}
        </Button>
      </DialogFooter>
      {current && confirmUsage && (
        <SwitchLibraryDialog
          open
          onOpenChange={(open) => !open && setConfirm(null)}
          from={{ repo: current.repo, branch: current.branch }}
          to={target}
          usage={confirmUsage}
          busy={connect.isPending}
          onConfirm={() => submit(true)}
        />
      )}
    </>
  );
};
