"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getApp, getApps } from "@onecli/api/apps/registry";
import type { AppDefinition } from "@onecli/api/apps/types";
import { ChevronRight, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import { Input } from "@onecli/ui/components/input";
import { AppIcon } from "@/lib/components/app-icon";
import { RequestAppSlot } from "@/lib/components/request-app-slot";
import {
  WORKSPACE_PATH_RE,
  agentSectionPath,
  connectionsPath,
} from "@/lib/navigation";
import { withConnectLinkAgent } from "@/lib/connect-link-agent";
import { useInstance } from "@/hooks/use-instance";
import { connectPopupHeight, openConnectPopup } from "@/lib/connect-popup";
import { queryKeys } from "@/lib/api/keys";
import { useAppMessages } from "@/hooks/use-app-connected";
import { useAgentDetail } from "@/hooks/use-agents";
import { useAvailableApps } from "@/hooks/use-available-apps";
import { useConnections } from "@/hooks/use-connections";
import { useInvalidateGrants } from "@/hooks/use-grants";
import {
  GITHUB_APP_PROVIDER,
  useSharedGitHubInstallations,
} from "@/hooks/use-github-app-share";
import { GitHubAppConnectDialog } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/github-app-connect-dialog";

/**
 * The agent-scoped app picker: search the catalog, Connect opens the OAuth
 * popup in place (the shared `openConnectPopup`). The connect carries THIS
 * agent, so a new account lands switched on (reads allowed, writes and
 * anything else needing approval) for it alone (the API's connecting-agent
 * grant): there is no grant to write here, and Manage is the scoping door.
 * The catalog honors the org app-availability restriction exactly like the
 * connections page's picker. Shared by the agent Connections section's Add
 * button and the chat's connector card, so both doors keep one contract.
 */
export const ConnectAppPickerDialog = ({
  agentId,
  open,
  onOpenChange,
  onConnected,
}: {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fires when a connect this dialog started CREATED an account. The
   *  caller decides what "next" looks like (the section opens its
   *  permissions sheet; the chat card toasts). */
  onConnected?: (connectionId: string) => void;
}) => {
  const [query, setQuery] = useState("");
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const invalidateGrants = useInvalidateGrants();
  const { data: connections = [] } = useConnections("workspace");
  const { data: availableApps } = useAvailableApps("workspace");
  // For the popup's success screen ("Go back to <agent>…") — cached from the
  // agent page's own detail read.
  const { data: agent } = useAgentDetail(agentId);
  const instance = useInstance();
  // React only to what THIS dialog initiated: a global message listener
  // also hears popups opened elsewhere (another tab, another surface).
  const initiated = useRef(new Set<string>());
  // GitHub App: an org admin is offered the installations already connected
  // in the org (shared with the org, never copied) before a GitHub install
  // popup. Members (no installations offered) get the popup.
  const [githubShareOpen, setGithubShareOpen] = useState(false);
  const { data: sharedInstallations = [] } = useSharedGitHubInstallations(
    "workspace",
    open,
  );

  // Each open starts fresh (the 1Password picker's rule) — the dialog stays
  // mounted across opens, so yesterday's search would leak into today's.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  useAppMessages({
    onConnected: ({ provider, connectionId }) => {
      if (!provider || !initiated.current.has(provider)) return;
      initiated.current.delete(provider);
      // The pool changed (a fresh account, or a re-add the callback deduped
      // onto an existing one), and either arrives switched on for this agent:
      // refresh the list, the grant views and the count badges.
      invalidateGrants();
      void queryClient.invalidateQueries({ queryKey: queryKeys.counts.all() });
      // Reconnects carry no connectionId and keep their grants.
      if (connectionId) onConnected?.(connectionId);
      onOpenChange(false);
    },
    // The popup reports an app that needs credentials configured before it
    // can connect (no platform defaults) — route to the app's config page,
    // the same escape the connections tabs and the chat card take. Fenced on
    // `initiated` so this dialog never reacts to popups it didn't open (the
    // chat card's own unfenced handler covers its rows).
    onConfigure: (provider) => {
      if (!initiated.current.has(provider)) return;
      initiated.current.delete(provider);
      onOpenChange(false);
      // The connect that follows the setup is still this agent's.
      router.push(
        withConnectLinkAgent(
          connectionsPath(
            { pathname },
            `/apps/${encodeURIComponent(provider)}`,
          ),
          agentId,
        ),
      );
    },
  });

  const connectedCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of connections.filter((c) => c.status === "connected")) {
      counts.set(c.provider, (counts.get(c.provider) ?? 0) + 1);
    }
    return counts;
  }, [connections]);

  const apps = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Availability (policy-engine step 7): when the org restricts apps, offer
    // only the allowed providers — the same law as the connections page's
    // catalog. `restricted:false` (an "open" org, or self-host) means the
    // whole catalog.
    const allowed = availableApps?.restricted
      ? new Set(availableApps.providers)
      : null;
    return [...getApps()]
      .filter((a) => allowed === null || allowed.has(a.id))
      .filter((a) => !q || a.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [query, availableApps]);

  // Slack is not a catalog app (the gateway never injects Slack creds): its
  // read access is a per-agent connection on this agent's Slack page, so the
  // row is a door there, offered only where that feature is entitled.
  const showSlack =
    instance?.entitled === true &&
    (!query.trim() || "slack".includes(query.trim().toLowerCase()));
  const hasSlackApp = (agent?.channels ?? []).some(
    (c) => c.provider === "slack" && c.status !== "pending_setup",
  );
  const openSlack = () => {
    onOpenChange(false);
    router.push(agentSectionPath(pathname, agentId, "channels"));
  };

  const openPopupFor = (app: AppDefinition) => {
    initiated.current.add(app.id);
    const popup = openConnectPopup(app.id, {
      agentName: agent?.name,
      agentId,
      workspaceId: pathname.match(WORKSPACE_PATH_RE)?.[1],
      height: connectPopupHeight(app),
    });
    // A blocked popup means no message will ever land — release the claim so
    // this listener can't adopt a later connect it didn't start.
    if (!popup) {
      initiated.current.delete(app.id);
      toast.error("Popup blocked. Allow popups for this site and try again.");
    }
  };

  const connect = (app: AppDefinition) => {
    if (app.id === GITHUB_APP_PROVIDER && sharedInstallations.length > 0) {
      onOpenChange(false);
      setGithubShareOpen(true);
      return;
    }
    openPopupFor(app);
  };

  const githubApp = getApp(GITHUB_APP_PROVIDER);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Connect an app</DialogTitle>
            <DialogDescription>
              Connecting turns the account on for this agent, not for your other
              agents. Reads are allowed. Writes and anything else need your
              approval (an app with no tool list gets full access). Adjust it
              anytime under Manage.
            </DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search apps…"
              aria-label="Search apps"
              className="pl-9"
              autoFocus
            />
          </div>
          <div className="-mx-1 max-h-80 space-y-0.5 overflow-y-auto px-1">
            {showSlack && (
              <button
                type="button"
                onClick={openSlack}
                className="hover:bg-muted flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors"
              >
                <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg border dark:bg-white/10 dark:border-white/10">
                  <AppIcon icon="/icons/slack.svg" name="Slack" size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">Slack</p>
                  <p className="text-muted-foreground truncate text-xs">
                    {hasSlackApp
                      ? "Connect your Slack so this agent can read channels you pick"
                      : "Add this agent to Slack first, then share channels"}
                  </p>
                </div>
                <ChevronRight
                  className="text-muted-foreground size-4 shrink-0"
                  aria-hidden
                />
              </button>
            )}
            {apps.map((app) => {
              const connected = connectedCount.get(app.id) ?? 0;
              return (
                <button
                  key={app.id}
                  type="button"
                  onClick={() => connect(app)}
                  title={
                    connected > 0
                      ? `Connect another ${app.name} account`
                      : undefined
                  }
                  className="hover:bg-muted flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors"
                >
                  <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg border dark:bg-white/10 dark:border-white/10">
                    <AppIcon
                      icon={app.icon}
                      darkIcon={app.darkIcon}
                      name={app.name}
                      size={18}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{app.name}</p>
                    <p className="text-muted-foreground truncate text-xs">
                      {app.description}
                    </p>
                  </div>
                  {connected > 0 && (
                    <span className="text-brand shrink-0 text-xs font-medium">
                      {connected === 1 ? "Connected" : `${connected} connected`}
                    </span>
                  )}
                </button>
              );
            })}
            {apps.length === 0 && !showSlack && (
              <p className="text-muted-foreground py-6 text-center text-sm">
                No apps found.
              </p>
            )}
            {/* Always last, searching included: a search that finds nothing
                is when someone wants to ask for the app. */}
            <div className="mt-1 grid">
              <RequestAppSlot initialName={query.trim() || undefined} />
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <GitHubAppConnectDialog
        open={githubShareOpen}
        onOpenChange={setGithubShareOpen}
        pageScope="workspace"
        agentId={agentId}
        onInstallNew={() => {
          if (githubApp) openPopupFor(githubApp);
        }}
        onConnected={(connectionId) => onConnected?.(connectionId)}
      />
    </>
  );
};
