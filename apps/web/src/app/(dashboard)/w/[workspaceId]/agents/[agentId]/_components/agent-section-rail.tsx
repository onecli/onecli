"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronLeft, SlidersHorizontal } from "lucide-react";
import { Badge } from "@onecli/ui/components/badge";
import { cn } from "@onecli/ui/lib/utils";
import { agentPath, matchAgentPage } from "@/lib/navigation";
import {
  agentSectionsFor,
  defaultAgentSection,
  AGENT_SECTION_GROUPS,
  type AgentSection,
} from "@/lib/agents/agent-sections";
import { connectedPresences } from "@/lib/agents/channel-providers";
import { channelProviderUi } from "@/lib/agents/channel-providers/registry";
import { AppIcon } from "@/lib/components/app-icon";
import { useCounts } from "@/hooks/use-counts";
import { useInstance } from "@/hooks/use-instance";
import type { AgentPageAgent } from "./agent-page-frame";

const RailLink = ({
  section,
  href,
  active,
  count,
  compact,
  prominent,
  connectedMark,
}: {
  section: Pick<AgentSection, "title" | "icon">;
  href: string;
  active: boolean;
  count?: number;
  compact?: boolean;
  /** The rail's primary action. Emphasis is WEIGHT on the same row shape as
   *  every other entry — a solid full-width block read as a banner and made
   *  the whole rail top-heavy. */
  prominent?: boolean;
  /** Brand mark replacing the lucide glyph when the section's integration is
   *  live — the Slack row shows the colorful mark once an install actually
   *  completed. `provider` names it for assistive tech: the row announces
   *  "(connected to <provider>)", so the signal is never color-only. */
  connectedMark?: { src: string; provider: string };
}) => (
  <Link
    href={href}
    aria-current={active ? "page" : undefined}
    className={cn(
      "focus-visible:ring-ring flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors outline-none focus-visible:ring-2",
      compact && "py-1 text-xs",
      // Brand colour means ONE thing in this rail: you are here. Everything
      // else is plain foreground — these are the agent's own sections, not
      // secondary links, and greying them made the rail read as mostly
      // disabled. Prominence is weight, and the group headings stay muted so
      // the rail still has a hierarchy.
      active
        ? cn(
            "bg-brand/10 text-brand",
            prominent ? "font-semibold" : "font-medium",
          )
        : cn("text-foreground hover:bg-muted", prominent && "font-semibold"),
    )}
  >
    {connectedMark ? (
      <span aria-hidden="true" className="flex shrink-0 items-center">
        <AppIcon
          icon={connectedMark.src}
          name={connectedMark.provider}
          size={compact ? 14 : 16}
        />
      </span>
    ) : (
      <section.icon
        className={cn("size-4", compact && "size-3.5")}
        aria-hidden
      />
    )}
    <span>{section.title}</span>
    {connectedMark && (
      <span className="sr-only">(connected to {connectedMark.provider})</span>
    )}
    {count !== undefined && count > 0 && (
      <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
        {count}
      </Badge>
    )}
  </Link>
);

/** The Advanced row on the main rail: one entry that drills into the
 *  Advanced view, like a workspace drills in from All workspaces. */
const ADVANCED_ENTRY = { title: "Advanced", icon: SlidersHorizontal } as const;

/**
 * The agent page's second rail (§3.18): every entry is a property of this one
 * agent. Which sections exist for this agent comes from the shared section
 * table, so the rail, the breadcrumb switcher and the frame's guard can never
 * disagree. On small screens the rail becomes a horizontal strip under the
 * header — same items, same order.
 *
 * Two views, chosen by the URL: the main view (Work, Access, Behavior, and
 * one Advanced row), and the Advanced view (a back link to the agent, then
 * the advanced sections), the same drill-in the dashboard sidebar does for a
 * workspace. Deriving the view from the path keeps deep links and refreshes
 * honest: an advanced section's URL always opens the Advanced view.
 *
 * The badges are the workspace's totals (how much there is to grant), read from
 * the counts endpoint the overview already warms rather than from full list
 * fetches. Connections carries apps + custom secrets, because that is exactly
 * what its two tabs hold.
 */
export const AgentSectionRail = ({ agent }: { agent: AgentPageAgent }) => {
  const pathname = usePathname();
  const base = agentPath(pathname, agent.id);
  const { data: counts } = useCounts();
  const instance = useInstance();

  // Instance-gated entries (SSH) exist only where the deployment has the
  // capability: hide once /v1/instance resolves WITHOUT it (auto-hide, never
  // a teased dead door), show while still loading — loading must never render
  // as unavailable (the availability.ts law).
  const sections = agentSectionsFor(agent.kind).filter(
    (s) =>
      s.instanceGated !== "ssh" ||
      instance === null ||
      instance.ssh !== undefined,
  );

  const countFor = (section: string) =>
    section === "connections"
      ? counts === undefined
        ? undefined
        : (counts.apps ?? 0) + (counts.secrets ?? 0)
      : section === "models"
        ? counts?.llms
        : undefined;

  const hrefFor = (s: AgentSection) => `${base}/${s.section}`;

  // The channels row's glyph becomes the provider's colorful mark once an
  // install actually COMPLETED — a `pending_setup` row (a clicked-but-
  // unfinished attach) keeps the grey glyph, the same line the section
  // itself draws. The first connected presence whose provider this build
  // knows supplies the mark.
  const connectedUi = connectedPresences(agent.channels)
    .map((presence) => channelProviderUi(presence.provider))
    .find((ui) => ui !== null);

  const renderLink = (s: AgentSection, compact?: boolean) => (
    <RailLink
      key={s.section}
      section={s}
      href={hrefFor(s)}
      active={pathname === hrefFor(s)}
      count={countFor(s.section)}
      compact={compact}
      prominent={s.prominent === true}
      connectedMark={
        s.section === "channels" && connectedUi
          ? { src: connectedUi.iconSrc, provider: connectedUi.name }
          : undefined
      }
    />
  );

  // Which view: the Advanced view whenever the current section is an advanced
  // one, else the main view. Each view lists only its own sections; the main
  // view's Advanced row (linking to the first advanced section) exists only
  // when this agent has at least one advanced section left after gating.
  const current = matchAgentPage(pathname)?.section;
  const advanced = sections.filter((s) => s.group === "advanced");
  const inAdvanced = advanced.some((s) => s.section === current);
  const viewSections = inAdvanced
    ? advanced
    : sections.filter((s) => s.group !== "advanced");
  const advancedHref =
    !inAdvanced && advanced[0] ? hrefFor(advanced[0]) : undefined;

  const renderBackLink = (compact?: boolean) => (
    <Link
      href={`${base}/${defaultAgentSection(agent.kind)}`}
      className={cn(
        "text-muted-foreground hover:text-foreground focus-visible:ring-ring flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-sm outline-none focus-visible:ring-2",
        compact && "py-1 text-xs",
      )}
    >
      <ChevronLeft className="size-3.5" aria-hidden />
      Back to agent
    </Link>
  );

  const renderAdvancedRow = (href: string, compact?: boolean) => (
    <RailLink
      section={ADVANCED_ENTRY}
      href={href}
      active={false}
      compact={compact}
    />
  );

  return (
    <>
      {/* Desktop: the rail. */}
      <aside className="hidden w-52 shrink-0 overflow-y-auto border-r md:block">
        <nav aria-label="Agent sections" className="flex flex-col gap-0.5 p-3">
          {inAdvanced && renderBackLink()}
          {AGENT_SECTION_GROUPS.map(({ group, label }) => {
            const items = viewSections.filter((s) => s.group === group);
            if (items.length === 0) return null;
            return (
              <div key={group} className="flex flex-col gap-0.5">
                {label !== null && (
                  <p className="text-muted-foreground/70 px-2 pt-3 pb-1 text-xs font-medium">
                    {label}
                  </p>
                )}
                {items.map((s) => renderLink(s))}
              </div>
            );
          })}
          {advancedHref && (
            <div className="mt-3 flex flex-col gap-0.5 border-t pt-3">
              {renderAdvancedRow(advancedHref)}
            </div>
          )}
        </nav>
      </aside>

      {/* Mobile: the same view as a horizontal strip. */}
      <div className="shrink-0 overflow-x-auto border-b md:hidden">
        <nav
          aria-label="Agent sections"
          className="flex min-w-max gap-1 px-2 py-1.5"
        >
          {inAdvanced && renderBackLink(true)}
          {viewSections.map((s) => renderLink(s, true))}
          {advancedHref && renderAdvancedRow(advancedHref, true)}
        </nav>
      </div>
    </>
  );
};
