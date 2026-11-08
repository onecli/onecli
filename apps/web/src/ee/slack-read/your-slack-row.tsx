"use client";

import { useCallback, useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, MoreHorizontal, RefreshCw, Unplug } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@onecli/ui/components/badge";
import { Button } from "@onecli/ui/components/button";
import { Skeleton } from "@onecli/ui/components/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import { AppIcon } from "@/lib/components/app-icon";
import { openInstallPopup } from "@/lib/agents/install-popup";
import { queryKeys } from "@/lib/api/keys";
import {
  useDisconnectSlack,
  useSlackReadConnection,
  useStartSlackConnect,
} from "./hooks";

export interface YourSlackRowProps {
  agentId: string;
  agentName: string;
}

/**
 * The viewer's own Slack on this agent, the compact line atop Contacts: connect,
 * reconnect (also how a read-only connection gains send scopes), or
 * disconnect (which also stops every share).
 */
export const YourSlackRow = ({ agentId, agentName }: YourSlackRowProps) => {
  const connection = useSlackReadConnection(agentId);
  const start = useStartSlackConnect(agentId);
  const disconnect = useDisconnectSlack(agentId);
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const autoStarted = useRef(false);
  const consumedReturn = useRef(false);
  const wantsConnect = searchParams.get("connect") === "slack";
  const returned = searchParams.get("connected") === "slack-read";

  const withoutParam = useCallback(
    (name: string) => {
      const rest = new URLSearchParams(searchParams.toString());
      rest.delete(name);
      const query = rest.toString();
      return query ? `${pathname}?${query}` : pathname;
    },
    [searchParams, pathname],
  );

  // The Slack consent flow lands back here (`?connected=slack-read`). In
  // the popup it opened, hand the result to the opener and close; in this
  // tab (popup blocked, or the Slack DM card's link), refresh in place.
  useEffect(() => {
    if (!returned || consumedReturn.current) return;
    consumedReturn.current = true;
    if (window.opener) {
      (window.opener as Window).postMessage(
        { type: "app-connected", provider: "slack-read" },
        window.location.origin,
      );
      window.close();
      return;
    }
    void qc.invalidateQueries({ queryKey: queryKeys.channels.all() });
    toast.success("Your Slack is connected");
    router.replace(withoutParam("connected"), { scroll: false });
  }, [returned, qc, router, withoutParam]);

  // Arrived from the Slack "Connect your Slack" card (`?connect=slack`):
  // start the connect flow once, as if the button was clicked. With no
  // click there is no popup gesture, so this goes to Slack in this tab.
  useEffect(() => {
    if (!wantsConnect || autoStarted.current || connection.isPending) return;
    autoStarted.current = true;
    router.replace(withoutParam("connect"));
    const data = connection.data;
    if (!data?.available || data.canWrite) return;
    start.mutate(undefined, {
      onSuccess: ({ authorizeUrl }) => {
        window.location.href = authorizeUrl;
      },
      onError: (err) =>
        toast.error(err instanceof Error ? err.message : "Couldn't start"),
    });
  }, [
    wantsConnect,
    connection.isPending,
    connection.data,
    router,
    withoutParam,
    start,
  ]);

  if (connection.isPending) return <Skeleton className="h-9 w-72" />;

  const data = connection.data;
  const connected = data?.connected ?? false;
  const available = data?.available ?? false;
  const canWrite = data?.canWrite ?? false;

  const connect = () => {
    // Opened inside the click (the gesture), pointed at Slack once the
    // authorize URL arrives, so no popup blocker eats it.
    const popup = openInstallPopup();
    start.mutate(undefined, {
      onSuccess: ({ authorizeUrl }) => {
        if (popup) popup.location.href = authorizeUrl;
        else window.location.href = authorizeUrl;
      },
      onError: (err) => {
        popup?.close();
        toast.error(err instanceof Error ? err.message : "Couldn't start");
      },
    });
  };

  const icon = (
    <span className="bg-muted flex size-7 shrink-0 items-center justify-center rounded-md border dark:border-white/10 dark:bg-white/10">
      <AppIcon icon="/icons/slack.svg" name="Slack" size={14} />
    </span>
  );

  const spinner = (
    <Loader2
      className="size-3.5 animate-spin motion-reduce:hidden"
      aria-hidden
    />
  );

  if (!connected) {
    return (
      <div className="flex min-h-11 items-center gap-3 rounded-md border border-dashed px-3 py-2">
        {icon}
        <p className="text-muted-foreground min-w-0 flex-1 text-sm text-pretty">
          {available
            ? `Connect your Slack so ${agentName} can read and send as you where you allow it.`
            : "This agent's Slack app can't connect personal accounts. Re-attach it with the guided setup."}
        </p>
        <Button
          size="sm"
          onClick={connect}
          disabled={!available || start.isPending}
        >
          {start.isPending ? (
            <>
              {spinner}
              Connecting…
            </>
          ) : (
            "Connect your Slack"
          )}
        </Button>
      </div>
    );
  }

  const profile = data?.profile ?? null;
  const handle = profile?.handle
    ? `@${profile.handle}`
    : (profile?.realName ?? profile?.email ?? "your account");

  const disconnectNow = () =>
    disconnect.mutate(undefined, {
      onSuccess: () =>
        toast.success("Disconnected. Everything you shared was removed."),
      onError: (err) =>
        toast.error(err instanceof Error ? err.message : "Disconnect failed"),
    });

  return (
    <div className="flex min-h-9 flex-wrap items-center gap-2 text-sm">
      <AppIcon icon="/icons/slack.svg" name="Slack" size={14} />
      <span className="text-muted-foreground">
        Acting as you uses your Slack:
      </span>
      <span className="font-medium" translate="no">
        {handle}
      </span>
      <span className="text-muted-foreground" aria-hidden>
        ·
      </span>
      {canWrite ? (
        <Badge
          variant="secondary"
          className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
        >
          Connected
        </Badge>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={connect}
          disabled={!available || start.isPending}
        >
          {start.isPending ? (
            spinner
          ) : (
            <RefreshCw className="size-3.5" aria-hidden />
          )}
          Reconnect to let {agentName} send as you
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          asChild
          disabled={disconnect.isPending || start.isPending}
        >
          <Button variant="ghost" size="icon" aria-label="More for your Slack">
            <MoreHorizontal className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={connect} disabled={!available}>
            <RefreshCw className="size-4" aria-hidden />
            Reconnect
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={disconnectNow}>
            <Unplug className="size-4" aria-hidden />
            Disconnect my Slack
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
