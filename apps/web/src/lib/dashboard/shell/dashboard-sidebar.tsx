"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { ChevronDown, Ellipsis } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";
import { useAgentsForWorkspace } from "@/hooks/use-agents";
import { useInstance } from "@/hooks/use-instance";
import { AGENT_SECTIONS } from "@/lib/agents/agent-sections";
import { matchAgentPage } from "@/lib/navigation";
import type { NavItem } from "@dashboard/nav-main";
import { ScopeHeader } from "./scope-header";
import { AgentHeader } from "./agent-header";
import { AgentNavSkeleton } from "./agent-nav-skeleton";
import { NavLink } from "./nav-link";
import { NavIconExtras } from "./nav-icon-extras";
import { SHELL_SIDEBAR } from "./shell-geometry";
import { shellNavRows, shellNavRowFor, type ShellNavRow } from "./shell-nav";
import { useNavIconLoop } from "./use-nav-icon-loop";

/** Whether a scope row is the page on screen. A row that opens the Settings
 *  modal (`?settings=`) is never "here": the modal sits over the page. */
const scopeActive = (pathname: string, url: string): boolean =>
  url.includes("?")
    ? false
    : url === "/"
      ? pathname === "/"
      : pathname.startsWith(url);

/**
 * The sidebar. Inside an agent: the agent's photo and name (editable in
 * place), its everyday rows, and a More disclosure with the rest. Outside
 * an agent (an org page, a workspace page that is not an agent's): the
 * scope's rows. The workspace's own rows (Connections, Activity, Settings)
 * are not offered inside an agent: its own rows reach each of them, and the
 * gear opens the modal. The org and workspace block sits at the bottom.
 */
export const DashboardSidebar = ({
  workspaceId,
  orgId,
  navItems,
}: {
  workspaceId: string | undefined;
  orgId: string | null;
  navItems: NavItem[];
}) => {
  const pathname = usePathname();
  const inAgent = matchAgentPage(pathname);
  const { data: agents, isPending } = useAgentsForWorkspace(
    workspaceId ?? "",
    workspaceId !== undefined,
  );
  const agent = inAgent
    ? agents?.find((a) => a.id === inAgent.agentId)
    : undefined;
  const instance = useInstance();
  // The rail's instance gate, verbatim: an instance-gated section hides once
  // `/v1/instance` resolves WITHOUT the capability, never while loading.
  const hidden = new Set(
    AGENT_SECTIONS.filter(
      (s) =>
        s.instanceGated !== undefined &&
        instance !== null &&
        instance[s.instanceGated] === undefined,
    ).map((s) => s.section),
  );
  const rows: ShellNavRow[] =
    workspaceId && agent
      ? shellNavRows({ workspaceId, agent, hiddenSections: hidden })
      : [];
  const activeRow = inAgent ? shellNavRowFor(rows, inAgent.section) : null;
  const main = rows.filter((r) => !r.more);
  const more = rows.filter((r) => r.more);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = activeRow?.more ?? false;
  const showMore = moreOpen || moreActive;
  const moreHover = useNavIconLoop(Ellipsis);

  return (
    <aside data-slot="dashboard-sidebar" className={SHELL_SIDEBAR}>
      {inAgent && workspaceId ? (
        agent ? (
          <>
            <AgentHeader agent={agent} />
            <nav aria-label="Agent pages" className="flex flex-col gap-0.5">
              {main.map((row) => (
                <NavLink
                  key={row.id}
                  href={row.href}
                  active={activeRow?.id === row.id}
                  icon={row.icon}
                  title={row.title}
                  prominent={row.prominent}
                />
              ))}
              {more.length > 0 && (
                <>
                  <button
                    type="button"
                    aria-expanded={showMore}
                    onClick={() => setMoreOpen((open) => !open)}
                    {...moreHover?.rowProps}
                    className="text-muted-foreground/70 hover:bg-foreground/[0.05] hover:text-muted-foreground focus-visible:ring-ring mt-1 flex items-center gap-2 rounded-md px-2 py-1 text-xs outline-none focus-visible:ring-2"
                  >
                    <Ellipsis
                      ref={moreHover?.svgRef}
                      className="size-4 shrink-0 overflow-visible"
                      aria-hidden
                    >
                      {moreHover && <NavIconExtras loop={moreHover.loop} />}
                    </Ellipsis>
                    <span className="flex-1 text-left">More</span>
                    <ChevronDown
                      className={cn(
                        "size-3 shrink-0 transition-transform duration-200 motion-reduce:transition-none",
                        showMore && "rotate-180",
                      )}
                      aria-hidden
                    />
                  </button>
                  {/* Always mounted: the rows ease open (grid 0fr to 1fr)
                      instead of popping in. While closed they are `inert`
                      (out of the tab order) and `aria-hidden` (out of the
                      accessibility tree, as they are off screen). */}
                  <div
                    inert={!showMore}
                    aria-hidden={!showMore}
                    className={cn(
                      "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
                      showMore
                        ? "grid-rows-[1fr] opacity-100"
                        : "grid-rows-[0fr] opacity-0",
                    )}
                  >
                    {/* Same column as the rows above: the extra pages are
                        pages like the rest, not children of "More". */}
                    <div className="flex min-h-0 flex-col gap-0.5 overflow-hidden">
                      {more.map((row) => (
                        <NavLink
                          key={row.id}
                          href={row.href}
                          active={activeRow?.id === row.id}
                          icon={row.icon}
                          title={row.title}
                        />
                      ))}
                    </div>
                  </div>
                </>
              )}
            </nav>
          </>
        ) : isPending ? (
          <AgentNavSkeleton />
        ) : null
      ) : (
        <nav aria-label="Pages" className="flex flex-col gap-0.5">
          {navItems.map((item) => (
            <NavLink
              key={item.url}
              href={item.url}
              active={scopeActive(pathname, item.url)}
              icon={item.icon}
              title={item.title}
            />
          ))}
        </nav>
      )}
      {/* Where you are: the org (and workspace), at the bottom, apart
          from the agent you're working with at the top. */}
      <div className="mt-auto pt-4">
        <ScopeHeader workspaceId={workspaceId} orgId={orgId} />
      </div>
    </aside>
  );
};
