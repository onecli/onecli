"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ExternalLink, MonitorOff } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { Skeleton } from "@onecli/ui/components/skeleton";
import { useDesktop } from "./use-desktop";
import { AgentAvatar } from "@/lib/agents/_components/agent-avatar";
import {
  agentPath,
  DESKTOP_TAKEOVER_PARAM,
  withWorkspacePrefix,
} from "@/lib/navigation";
import { DesktopTheater } from "./desktop-theater";
import { useDesktopSession } from "./use-desktop-session";
import { useAgentPageAgent } from "@/app/(dashboard)/w/[workspaceId]/agents/[agentId]/_components/agent-page-frame";
import { EmptyState } from "@/app/(dashboard)/w/[workspaceId]/agents/[agentId]/_components/empty-state";

const REQUEST_ID_RE = /^[0-9a-f-]{36}$/;

export const DesktopTheaterPage = () => {
  const agent = useAgentPageAgent();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data, isPending, isError, refetch } = useDesktop(agent.id);
  const session = useDesktopSession(agent.id, agent.name);
  const [fromRequest, setFromRequest] = useState<string | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const focusedRequest = useRef<string | null>(null);

  useEffect(() => {
    const raw = searchParams.get(DESKTOP_TAKEOVER_PARAM);
    if (raw === null) return;
    if (REQUEST_ID_RE.test(raw)) setFromRequest(raw);
    const url = new URL(window.location.href);
    url.searchParams.delete(DESKTOP_TAKEOVER_PARAM);
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [searchParams]);

  // A link is a focus hint, never permission to acquire the control lease.
  useEffect(() => {
    if (
      !fromRequest ||
      focusedRequest.current === fromRequest ||
      session.status !== "connected"
    )
      return;
    const take = stage.current?.querySelector<HTMLButtonElement>(
      "button[data-desktop-take-control]",
    );
    if (take && !take.disabled) {
      take.focus();
      focusedRequest.current = fromRequest;
    }
  }, [fromRequest, session.status, data]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-black text-white">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-white/10 px-3 py-2 sm:px-5">
        <AgentAvatar agent={agent} />
        <nav
          aria-label="Computer breadcrumb"
          className="flex min-w-0 flex-1 items-center gap-2 text-sm"
        >
          <span className="truncate font-medium">{agent.name}</span>
          <span aria-hidden className="text-white/40">
            /
          </span>
          <h1 className="text-white/60">Computer</h1>
        </nav>
        <Button variant="ghost" className="min-h-11" asChild>
          <Link
            href={`${agentPath(pathname, agent.id)}/chat`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open chat <ExternalLink className="size-4" aria-hidden />
          </Link>
        </Button>
        <Button variant="ghost" className="min-h-11" asChild>
          <Link href={withWorkspacePrefix(pathname, "/agents")}>
            Open dashboard
          </Link>
        </Button>
      </header>
      <div
        ref={stage}
        className="flex min-h-0 flex-1 flex-col gap-3 p-3 [container-type:size] sm:p-8"
      >
        {isPending ? (
          <div
            aria-busy="true"
            aria-label="Loading computer"
            className="flex min-h-0 flex-1 flex-col gap-3"
          >
            <Skeleton className="min-h-0 flex-1" />
            <Skeleton className="mx-auto h-11 w-64" />
          </div>
        ) : isError || !data ? (
          <EmptyState
            icon={MonitorOff}
            title="Couldn’t load the computer."
            description="Check your connection and try again."
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() => void refetch()}
              >
                Try again
              </Button>
            }
          />
        ) : (
          <>
            {fromRequest && data.sandboxState === "asleep" && (
              <p className="text-center text-sm text-white/60">
                The agent asked for help, but its computer has since gone to
                sleep. Wake it to see the screen as the agent left it.
              </p>
            )}
            <DesktopTheater agentId={agent.id} state={data} session={session} />
          </>
        )}
      </div>
    </div>
  );
};
