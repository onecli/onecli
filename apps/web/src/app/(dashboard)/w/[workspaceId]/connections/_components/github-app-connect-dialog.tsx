"use client";

import { useState } from "react";
import Image from "next/image";
import { toast } from "sonner";
import {
  ArrowLeft,
  Building2,
  ChevronRight,
  ExternalLink,
  Plus,
  Loader2,
  User,
} from "lucide-react";
import { Button } from "@onecli/ui/components/button";
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
  useShareGitHubInstallation,
  useSharedGitHubInstallations,
} from "@/hooks/use-github-app-share";

export interface GitHubAppConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pageScope: PageScope;
  /** The agent this connect starts from (an agent page's picker): the shared
   * connection is switched on for it. Omitted on the Connections page. */
  agentId?: string;
  /** Runs the normal GitHub install flow (a GitHub org not connected yet). */
  onInstallNew: () => void;
  onConnected: (connectionId: string) => void;
}

/**
 * Connect GitHub App from any workspace or the org level. GitHub allows one
 * installation per account, and OneCLI keeps one connection per installation:
 * an account another workspace already connected is shared with the whole
 * organization (its connection moves up, nothing is copied), and every
 * workspace turns it on per agent. A new account installs on GitHub.
 */
export const GitHubAppConnectDialog = ({
  open,
  onOpenChange,
  pageScope,
  agentId,
  onInstallNew,
  onConnected,
}: GitHubAppConnectDialogProps) => {
  const [selected, setSelected] = useState<SharedGitHubInstallation | null>(
    null,
  );
  const { data: installations = [], isPending: loadingInstallations } =
    useSharedGitHubInstallations(pageScope, open);
  const share = useShareGitHubInstallation(pageScope);

  const handleOpenChange = (next: boolean) => {
    if (!next) setSelected(null);
    onOpenChange(next);
  };

  const handleShare = () => {
    if (!selected) return;
    share.mutate(
      {
        sourceConnectionId: selected.sourceConnectionId,
        ...(agentId ? { agentId } : {}),
      },
      {
        onSuccess: (shared) => {
          toast.success(
            `${selected.account ?? "GitHub"} is now shared with every workspace`,
          );
          handleOpenChange(false);
          onConnected(shared.id);
        },
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : "Failed to share"),
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
                onClick={() => setSelected(null)}
                aria-label="Back to accounts"
              >
                <ArrowLeft className="size-4" />
              </Button>
            )}
            <span className="truncate">
              {selected
                ? `Share ${selected.account ?? "this account"} with the organization?`
                : "Connect GitHub App"}
            </span>
          </DialogTitle>
          <DialogDescription className="text-xs">
            {selected
              ? "It moves to the organization level, so every workspace can turn it on for its agents. Agents that use it keep their access. Only organization admins can change or disconnect it after this."
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
                {installations.map((inst) => {
                  // Already reaches this scope (its own, or the org level's):
                  // turned on per agent, never connected twice.
                  const here = inst.connectedHere > 0;
                  return (
                    <button
                      key={inst.sourceConnectionId}
                      type="button"
                      disabled={here}
                      onClick={() => setSelected(inst)}
                      className={cn(
                        "focus-visible:ring-ring flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none",
                        here
                          ? "cursor-default bg-muted/30"
                          : "hover:bg-muted/50",
                      )}
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
                          {here
                            ? pageScope === "workspace"
                              ? "Already available here · turn it on per agent"
                              : "Already connected for the organization"
                            : "Connected in another workspace · share it with the organization"}
                        </p>
                      </div>
                      {!here && (
                        <ChevronRight className="text-muted-foreground size-4 shrink-0" />
                      )}
                    </button>
                  );
                })}
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
                      Install on a new GitHub account
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
          <DialogFooter className="px-5 py-3">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleShare}
              disabled={share.isPending}
              loading={share.isPending}
            >
              {share.isPending ? "Sharing..." : "Share with organization"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
};
