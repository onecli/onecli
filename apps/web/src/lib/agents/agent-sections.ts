/**
 * The agent page's sections, one table, because the same law is read from
 * three places: the sidebar builds its rows from it, the page frame refuses
 * a section this agent cannot have, and the frame also decides which
 * section owns the page's full height. Hand-copies of "chat is hosted-only"
 * would drift the first time a section is added.
 *
 * The sidebar additionally hides `instanceGated` entries when the deployment
 * lacks the capability (`GET /v1/instance`), a capability gate, not a kind
 * gate, so it stays out of the kind-keyed consumers: the frame's guard
 * remains kind-only, and a hand-typed URL into a gated section is answered
 * by that section's own quiet empty state.
 *
 * Old segments that merged into these pages (`instructions`, `skills`,
 * `memory` into Knowledge; `channels` into Contacts; `models`, `ssh` into
 * Agent settings; `apps`, `secrets` into Connections) are not sections:
 * their routes are server redirects (`lib/dashboard/merged-section-redirect`).
 */
export interface AgentSection {
  /** Path segment under `/w/<id>/agents/<agentId>`. The index (`""`) is NOT a
   *  section: it redirects to the first one this agent has. */
  section: string;
  /** Hosted only: a BYO agent has no computer to talk to and no brief. */
  hostedOnly?: boolean;
  /**
   * Exists only where the deployment has the named capability: the SIDEBAR
   * hides the entry when `GET /v1/instance` resolves without it (the
   * auto-hide posture, a surface that cannot exist on this deployment is
   * absent, not teased). While the instance is still loading the entry SHOWS:
   * loading must never render as unavailable (the availability.ts law). The
   * frame's guard stays kind-only, so a hand-typed URL still reaches the
   * section, which renders its own quiet empty state.
   */
  instanceGated?: "ssh" | "previews";
  /** Owns the page's full height: no scrolling section shell. */
  fullHeight?: boolean;
  /** Standalone screen host: no dashboard chrome and no sidebar row. */
  theater?: true;
}

/** In sidebar order: the first section a kind of agent has is its home. */
export const AGENT_SECTIONS: readonly AgentSection[] = [
  { section: "chat", hostedOnly: true, fullHeight: true },
  {
    // The standalone screen host for deep links and pop-outs. Kept in the
    // table for the guard, but never offered in the sidebar. Hosted-only
    // and preview-capable, just like the screen in Chat.
    section: "computer",
    hostedOnly: true,
    instanceGated: "previews",
    theater: true,
  },
  // Instructions, Skills and Memory on one page. A BYO agent has no brief
  // to merge.
  { section: "knowledge", hostedOnly: true },
  // Everything the agent can reach: apps and custom secrets. The URL stays
  // `connections`; the sidebar calls it Apps.
  { section: "connections" },
  // WHO the agent may talk with: the people, channels, other agents and apps
  // it may reach or be reached by, with the Slack card on top.
  // A BYO agent is not reached through the platform at all.
  { section: "contacts", hostedOnly: true },
  // Schedules wake a HOSTED agent's sandbox.
  { section: "schedules", hostedOnly: true },
  // The agent's runs and requests. A BYO agent has no runs.
  { section: "activity", hostedOnly: true },
  // Test questions with known answers, run against the live agent.
  { section: "evals", hostedOnly: true },
  // Inbound webhooks: an external app's event triggers the agent.
  { section: "webhooks", hostedOnly: true },
  // Shared ports (plans/sandbox-ports.md): private preview links to services
  // on the agent's computer. Only deployments that serve previews show it.
  { section: "ports", hostedOnly: true, instanceGated: "previews" },
  // Models, SSH and the agent's facts on one page. Not
  // hosted-only: a BYO agent has a model. The page itself hides SSH where
  // the deployment has no SSH front door.
  { section: "settings" },
] as const;

/**
 * Where the agent index (`/agents/<id>`) sends you: the first section this
 * kind of agent has, Chat for a hosted agent, Connections for a BYO one.
 * There is no Overview section (the agent's facts live on Agent settings
 * and in the top bar's Details dialog), so the index must land somewhere
 * real.
 */
export const defaultAgentSection = (kind: string): string =>
  agentSectionsFor(kind)[0]?.section ?? "connections";

/** The sections an agent of this kind actually has. */
export const agentSectionsFor = (kind: string): AgentSection[] =>
  AGENT_SECTIONS.filter((s) => s.hostedOnly !== true || kind === "hosted");

/**
 * A REAL section this agent's kind cannot have: the hand-typed-URL and
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

export const isTheaterAgentSection = (section: string): boolean =>
  AGENT_SECTIONS.some((s) => s.section === section && s.theater === true);
