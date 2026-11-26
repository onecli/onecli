import type { AgentPeerWire } from "@onecli/agent-protocol";
import type { CapabilityFragment } from "../home/renderer";
import type { PlatformToolDefinition } from "../platform-tools";

/**
 * The agents capability (PR 5b): the OTHER OneCLI agents this one may
 * message, and the one tool that reaches them. Fragment and tool arrive
 * together and disappear together (the §3.7 registry law), keyed on the
 * roster the control plane composed at dispatch - the exact shape of the
 * channels capability, for the exact reason: say the peers as standing fact,
 * gate the tool on them, re-render when the roster changes.
 *
 * Bare mechanism only. What the tool does, what its two answers mean, how
 * a peer's words arrive. Nothing about when to talk to another agent or how
 * to talk: the deterministic layer (consent cards, the turn cap) is where
 * safety lives, and conditional truths are spoken by the platform's own
 * notices at the moment they apply.
 *
 * Control-plane executed (no local `execute`): the consent walk, the
 * delivery, and the fence live in the control plane.
 */

/** No peers -> no section, no tool. */
export const agentsFragment = (
  peers: readonly AgentPeerWire[],
): CapabilityFragment | null => {
  if (peers.length === 0) return null;
  const names = peers.map((peer) => peer.name).join(", ");
  return {
    id: "agents",
    title: "Other agents",
    body: [
      `Other OneCLI agents you can message: ${names}.`,
      "",
      "message_agent sends a message to one of them by its exact name. Delivery may need the owners' one-time approval:",
      '- "sent" = delivered.',
      '- "held" = the owners were asked; the decision arrives as a notice at the start of a later turn, so never promise to follow up on your own.',
      "",
      "Each other agent you talk with has its own conversation with you. Its messages arrive there prefixed `Name (agent):`; to answer, use message_agent with that agent's name.",
      "",
      "When you message an agent while answering a person, that opens a task for the person: the whole back-and-forth then happens in your conversation with that agent (the person does not see it), and the tool result tells you so. When you have what the person needs, call complete_task there with a report written for the person; the report reaches them on its own, in the conversation they asked in. Each task has a fixed number of messages per side; the conversation tells you how many are left, and the platform closes the task for you if they run out.",
    ].join("\n"),
  };
};

/** The tools - present exactly when the roster is non-empty. */
export const agentsTools = (
  peers: readonly AgentPeerWire[],
): PlatformToolDefinition[] => {
  if (peers.length === 0) return [];
  return [
    {
      name: "message_agent",
      description:
        'Send a message to another OneCLI agent by its exact name (the "Other agents" list). Delivery may need the owners\' one-time approval: the result says "sent" (delivered) or "held" (owners asked; the decision arrives as a notice in this conversation). The agent\'s reply arrives prefixed with its name in your conversation with that agent. Called while answering a person, it opens a task for them: continue in your conversation with the agent and finish with complete_task there.',
      inputSchema: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: "The other agent's exact name (e.g. 'Ray').",
          },
          text: {
            type: "string",
            description:
              "The message, in plain words. Sent as written - the owners see exactly this text when approval is needed.",
          },
        },
        required: ["to", "text"],
      },
    },
    {
      name: "complete_task",
      description:
        "Finish the task a person gave you for another agent: deliver your report to that person and close the task. Call it from your conversation with the other agent once you have what the person needs (or once the messages run out). Write the report for the person, in your own words; it is the only thing they receive from this task. Not for scheduled tasks.",
      inputSchema: {
        type: "object",
        properties: {
          report: {
            type: "string",
            description:
              "Your report to the person, complete and in plain words. If the other agent needs something only the person can answer, put the question here.",
          },
          peer: {
            type: "string",
            description:
              "Only when you have open tasks with several agents and are not calling from one of those conversations: the other agent's exact name.",
          },
        },
        required: ["report"],
      },
    },
  ];
};
