import {
  Activity,
  BookOpen,
  CalendarClock,
  FlaskConical,
  Globe,
  MessageSquare,
  Plug,
  Settings,
  Users,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { agentSectionsFor } from "@/lib/agents/agent-sections";
import { agentPagePath } from "@/lib/navigation";

/**
 * The sidebar's rows for one agent (plans/flatten-ui.md): the everyday
 * pages in the open, the rest under "More". Built from the section table,
 * so a section a BYO agent cannot have (chat, knowledge, ...) never gets a
 * row, and an instance-gated section (Ports) hides the same way the frame
 * hides it.
 */
export interface ShellNavRow {
  /** Stable id for tests and the active match (the section segment). */
  id: string;
  title: string;
  icon: LucideIcon;
  href: string;
  /** The section segment this row owns. */
  section: string;
  /** Under the "More" disclosure. */
  more?: true;
  /** The sidebar's one emphasised row (Chat). */
  prominent?: true;
}

/**
 * Rows in sidebar order, keyed by the section they open. The title comes
 * from here: the sidebar says "Apps" over the `connections` segment.
 */
const ROWS: readonly {
  section: string;
  title: string;
  icon: LucideIcon;
  more?: true;
  prominent?: true;
}[] = [
  { section: "chat", title: "Chat", icon: MessageSquare, prominent: true },
  { section: "knowledge", title: "Knowledge", icon: BookOpen },
  { section: "connections", title: "Apps", icon: Plug },
  { section: "contacts", title: "Contacts", icon: Users },
  { section: "schedules", title: "Schedules", icon: CalendarClock },
  // More: rare or technical.
  { section: "activity", title: "Activity", icon: Activity, more: true },
  { section: "evals", title: "Evals", icon: FlaskConical, more: true },
  { section: "webhooks", title: "Webhooks", icon: Webhook, more: true },
  { section: "ports", title: "Ports", icon: Globe, more: true },
  { section: "settings", title: "Agent settings", icon: Settings, more: true },
];

interface ShellNavInput {
  workspaceId: string;
  agent: { id: string; kind: string };
  /** Sections the deployment hides (the instance gate), by segment. */
  hiddenSections?: ReadonlySet<string>;
}

/** The rows this agent gets, in order. */
export const shellNavRows = ({
  workspaceId,
  agent,
  hiddenSections,
}: ShellNavInput): ShellNavRow[] => {
  const available = new Set(
    agentSectionsFor(agent.kind)
      .filter((s) => !s.theater && !hiddenSections?.has(s.section))
      .map((s) => s.section),
  );
  return ROWS.flatMap((row) =>
    available.has(row.section)
      ? [
          {
            id: row.section,
            title: row.title,
            icon: row.icon,
            href: agentPagePath(workspaceId, agent.id, row.section),
            section: row.section,
            ...(row.more && { more: true as const }),
            ...(row.prominent && { prominent: true as const }),
          },
        ]
      : [],
  );
};

/** The row that owns `section`, or null (the index, an unknown segment). */
export const shellNavRowFor = (
  rows: readonly ShellNavRow[],
  section: string,
): ShellNavRow | null => rows.find((row) => row.section === section) ?? null;
