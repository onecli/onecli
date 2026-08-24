import {
  Brain,
  Cpu,
  MessageSquare,
  Slack,
  Plug,
  ScrollText,
  Sparkles,
  Terminal,
  type LucideIcon,
  CalendarClock,
} from "lucide-react";

/**
 * The agent page's sections (§3.18) — one table, because the same law is read
 * from four places: the rail renders it, the breadcrumb switcher decides
 * whether it can hold the current section across a switch, the page frame
 * refuses a section this agent cannot have, and the frame also decides which
 * section owns the page's full height. Four hand-copies of "chat and
 * instructions are hosted-only" would drift the first time a section is
 * added, and the drift is invisible: the rail would stop offering a section
 * the switcher still navigates into.
 *
 * The rail alone additionally hides `instanceGated` entries when the
 * deployment lacks the capability (`GET /v1/instance`) — a capability gate,
 * not a kind gate, so it stays out of the three kind-keyed consumers: the
 * frame's guard and the switcher remain kind-only, and a hand-typed URL into
 * a gated section is answered by that section's own quiet empty state.
 */
export interface AgentSection {
  /** Path segment under `/w/<id>/agents/<agentId>`. The index (`""`) is NOT a
   *  section: it redirects to the first one this agent has. */
  section: string;
  title: string;
  icon: LucideIcon;
  /**
   * Which rail cluster it sits in, in render order: Work (the thread), then
   * what the agent is given (Access: the connections it can reach and the
   * model it runs on), then how it behaves (Behavior).
   */
  group: "chat" | "access" | "behavior";
  /** Hosted only: a BYO agent has no computer to talk to and no brief. */
  hostedOnly?: boolean;
  /**
   * Exists only where the deployment has the named capability: the RAIL hides
   * the entry when `GET /v1/instance` resolves without it (the PR-#869
   * auto-hide posture — a surface that cannot exist on this deployment is
   * absent, not teased). While the instance is still loading the entry SHOWS:
   * loading must never render as unavailable (the availability.ts law). The
   * frame's guard stays kind-only, so a hand-typed URL still reaches the
   * section, which renders its own quiet empty state.
   */
  instanceGated?: "ssh";
  /** Owns the page's full height — no scrolling section shell. */
  fullHeight?: boolean;
  /** The rail's ONE primary action — weight and colour on the ordinary row
   *  shape. A property of the section, not its cluster: Slack shares Chat's
   *  cluster without sharing its prominence. */
  prominent?: boolean;
}

/** The rail's cluster order and their labels — three plain answers: where
 *  you WORK with the agent, what it is given (Access), and how it behaves
 *  (Behavior). */
export const AGENT_SECTION_GROUPS: readonly {
  group: AgentSection["group"];
  label: string | null;
}[] = [
  { group: "chat", label: "Work" },
  { group: "access", label: "Access" },
  { group: "behavior", label: "Behavior" },
] as const;

export const AGENT_SECTIONS: readonly AgentSection[] = [
  {
    section: "chat",
    title: "Chat",
    icon: MessageSquare,
    group: "chat",
    hostedOnly: true,
    fullHeight: true,
    // Chat alone leads visually: the thread is the rail's primary action.
    prominent: true,
  },
  {
    // The OTHER place this agent is talked to (§3.16): Slack sits beside Chat
    // under Work, because both answer "where do I reach it", not "how does it
    // behave". Named for the provider a user recognizes in their workspace
    // rather than the platform-neutral "Channels" — the URL stays `channels`,
    // which is the provider-neutral platform layer underneath.
    section: "channels",
    title: "Slack",
    icon: Slack,
    group: "chat",
    hostedOnly: true,
  },
  // Access: everything the agent can reach, in ONE section (§3.18 as
  // amended). Apps and custom secrets were two rail entries asking the same
  // question — they are now the two tabs of Connections.
  { section: "connections", title: "Connections", icon: Plug, group: "access" },
  // The model sits under Access too: it is the other thing the agent is
  // GIVEN, beside the connections it can reach.
  { section: "models", title: "Models", icon: Cpu, group: "access" },
  {
    // A shell on the agent's computer (sandbox-platform step 5) is the other
    // way IN — an Access entry. Hosted-only (a BYO agent has no computer) and
    // instance-gated: only deployments with the SSH front door show it.
    section: "ssh",
    title: "SSH",
    icon: Terminal,
    group: "access",
    hostedOnly: true,
    instanceGated: "ssh",
  },
  {
    section: "instructions",
    title: "Instructions",
    icon: ScrollText,
    group: "behavior",
    hostedOnly: true,
  },
  {
    // Skills are how THIS agent works — a property of the agent, not of the
    // workspace (§3.18 as amended); the workspace-level page is gone.
    section: "skills",
    title: "Skills",
    icon: Sparkles,
    group: "behavior",
    hostedOnly: true,
  },
  {
    section: "schedules",
    title: "Schedules",
    icon: CalendarClock,
    group: "behavior",
    hostedOnly: true,
  },
  {
    section: "memory",
    title: "Memory",
    icon: Brain,
    group: "behavior",
    hostedOnly: true,
  },
] as const;

/**
 * Where the agent index (`/agents/<id>`) sends you: the first section this
 * kind of agent has — Chat for a hosted agent, Connections for a BYO one.
 * There is no Overview section any more (the agent's facts are the header
 * menu's Details dialog), so the index must land somewhere real.
 */
export const defaultAgentSection = (kind: string): string =>
  agentSectionsFor(kind)[0]?.section ?? "connections";

/** The sections an agent of this kind actually has. */
export const agentSectionsFor = (kind: string): AgentSection[] =>
  AGENT_SECTIONS.filter((s) => s.hostedOnly !== true || kind === "hosted");

/**
 * A REAL section this agent's kind cannot have — the hand-typed-URL and
 * switch-agents backstop. An unknown segment is deliberately not "blocked":
 * that is Next's 404, not ours.
 */
export const agentSectionBlocked = (section: string, kind: string): boolean =>
  AGENT_SECTIONS.some(
    (s) => s.section === section && s.hostedOnly === true && kind !== "hosted",
  );

/** Does this section own the page's full height (no scrolling shell)? */
export const isFullHeightAgentSection = (section: string): boolean =>
  AGENT_SECTIONS.some((s) => s.section === section && s.fullHeight === true);

/**
 * The section's display title for URL-derived surfaces (the header
 * breadcrumb): the table's word ("Slack"), never a title-cased URL segment
 * ("Channels") — the exact drift this table exists to prevent. `undefined`
 * for segments that aren't sections.
 */
export const agentSectionTitle = (section: string): string | undefined =>
  AGENT_SECTIONS.find((s) => s.section === section)?.title;
