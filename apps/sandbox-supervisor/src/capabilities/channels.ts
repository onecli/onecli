import {
  cleanLabel,
  type AgentChannelPresenceWire,
} from "@onecli/agent-protocol";
import type { CapabilityFragment } from "../home/renderer";
import type { PlatformToolDefinition } from "../platform-tools";

/**
 * The channels capability (plans/channel-aware-agents.md): the agent's own
 * standing truth about WHERE it can be talked to — its own Slack app, later
 * others — and the messaging tools that only make sense when such a place
 * exists. Fragment and tools arrive together and disappear together (the
 * §3.7 registry law), keyed on the presences the control plane composed at
 * dispatch.
 *
 * Why this section exists at all: without it the agent learned about chat
 * platforms only from the gateway teaching ("all outside access goes through
 * the gateway"), so "send me a message on Slack" became an attempt to call
 * slack.com through the proxy — which fails with app_not_connected and ends
 * in the agent asking someone to connect Slack while answering them IN Slack.
 * The industry pattern (hermes `PLATFORM_HINTS`, openclaw's `channel=` runtime
 * line + `## Messaging` gated on the message tool, nanoclaw's destinations
 * section) is the same everywhere: say the channel as standing fact, gate
 * the messaging tools on it, and re-render when the wiring changes.
 *
 * Three renderings, decided by the presence list:
 *  - NO presences → no section, no tools. The doc is silent about chat
 *    platforms, and the connections section no longer lists "chat" as a
 *    gateway service, so there is nothing to reach for.
 *  - at least one LIVE presence (active / needs_attention) → the section
 *    names the platform, the handle and the workspace, states the gateway
 *    rule for chat, and teaches the two tools, which are present.
 *  - only REMOVED presences (disabled) → the section says the app was
 *    removed and what restores it; the tools are not OFFERED (the bridge
 *    lists none). A harness session that already held them may still
 *    list them — jcode unions discovered tools across resumes and never
 *    drops one (observed live, 2026-09-15) — so the copy tells the model a
 *    listed messaging tool no longer works, and the platform-tools socket
 *    answers such a call with the same explanation instead of "unknown".
 *
 * Control-plane executed (no local `execute`): the sends and the searches
 * need the DB, the provider roster, and the tenant fence — none of which
 * live in this container.
 */

/** Per-provider display facts the copy needs. A second provider is a row
 * here, not a branch in the prose. */
interface ProviderDisplay {
  /** The platform's proper name ("Slack"). */
  name: string;
  /** How a person's handle reads on the platform. */
  handlePrefix: string;
  /** How the platform renders the agent's markdown, in one sentence. */
  formatting: string;
}

const PROVIDERS: Record<string, ProviderDisplay> = {
  slack: {
    name: "Slack",
    handlePrefix: "@",
    formatting:
      "Slack renders your markdown as Slack formatting; tables become monospace blocks, so prefer bullets or labeled lines.",
  },
};

/**
 * Unknown provider ids (a newer control plane) still render honestly:
 * title-cased id, generic handle, no formatting sentence. The id is a closed
 * registry value on the control plane, but this is platform voice, so it
 * gets the same single-line discipline as every other spliced string.
 */
const displayOf = (provider: string): ProviderDisplay => {
  const known = PROVIDERS[provider];
  if (known) return known;
  const id = cleanLabel(provider, 40);
  return {
    name: id.charAt(0).toUpperCase() + id.slice(1),
    handlePrefix: "@",
    formatting: "",
  };
};

const isLive = (presence: AgentChannelPresenceWire): boolean =>
  presence.status === "active" || presence.status === "needs_attention";

/** "as @donna in the Acme workspace" — whichever facts the platform knows. */
const whereOf = (
  presence: AgentChannelPresenceWire,
  display: ProviderDisplay,
): string => {
  const parts: string[] = [];
  if (presence.handle)
    parts.push(`as ${display.handlePrefix}${presence.handle}`);
  if (presence.workspaceName)
    parts.push(`in the ${presence.workspaceName} workspace`);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
};

/** "Slack" / "Slack and Teams": one name per provider, however many rows. */
const platformNamesOf = (
  presences: readonly AgentChannelPresenceWire[],
  joiner: string,
): string =>
  [...new Set(presences.map((p) => displayOf(p.provider).name))].join(joiner);

const liveSection = (live: AgentChannelPresenceWire[]): string => {
  const platformList = platformNamesOf(live, " and ");
  const lines: string[] = [];

  for (const presence of live) {
    const display = displayOf(presence.provider);
    lines.push(
      `You are reachable on ${display.name}${whereOf(presence, display)}, through your own ${display.name} app that the platform runs for you.`,
    );
    if (presence.status === "needs_attention") {
      // Honest about the control plane's current posture: send_message and
      // find_recipient resolve `active` presences only, so a needs_attention
      // presence still receives and answers, but proactive sends are refused
      // until it is re-attached.
      lines.push(
        `${display.name} approvals and proactive sends are paused for this app until it is re-attached in the dashboard; you still receive and can answer messages there.`,
      );
    }
  }

  lines.push(
    "",
    `A person may be talking to you from the OneCLI dashboard or from ${platformList}. When a turn opens with a "This is a direct conversation with…" note, or messages carry a \`name:\` prefix, it came from ${platformList}.`,
    "",
    `${platformList} is NOT a gateway connection and not something to set up: never call its API yourself, never ask anyone to connect ${platformList}, and never say you lack ${platformList} access. You already live there.`,
    "",
    "- To reply to the person you are talking with, just answer; the platform delivers it where they wrote from.",
    "- To message someone else, or a channel, use send_message (below).",
  );
  for (const presence of live) {
    const display = displayOf(presence.provider);
    if (display.formatting) lines.push(`- ${display.formatting}`);
  }

  lines.push(
    "",
    "People and channels have exact names you may not know. When you need to mention someone and their exact name is not in the conversation's Mentionable list, use find_recipient to search the workspace by approximate name.",
    "",
    "- Write the mention form a result gives you and the platform turns it into a real ping of that exact person. That's the whole flow: find, tag, done.",
    "- Channels work the same way: a channel result's mention form renders as a clickable channel link in your reply.",
    `- Results marked kind: app are ${platformList} apps. Write @[app] with your message in a channel reply to invoke the app right there. Only write @[app] when you intend to invoke it; as prose, use the bare name.`,
    "",
    "send_message reaches people and channels directly, outside the current conversation, on your own initiative or when asked. Use the recipient's exact name (a find_recipient result or the Mentionable list); #channel-name reaches a channel.",
    "",
    '- "sent" = delivered. "held" = the workspace owner was asked first; the decision arrives as a notice at the start of a later turn, so never promise to follow up on your own.',
  );
  return lines.join("\n");
};

const removedSection = (removed: AgentChannelPresenceWire[]): string => {
  const lines: string[] = [];
  for (const presence of removed) {
    const display = displayOf(presence.provider);
    lines.push(
      `Your ${display.name} app${whereOf(presence, display)} was removed from the workspace (uninstalled, or its access revoked). You cannot send or receive ${display.name} messages until someone re-attaches it from your Channels page in the OneCLI dashboard. If a send_message or find_recipient tool is still listed for you, it no longer works: do not call it.`,
    );
  }
  const names = platformNamesOf(removed, " and ");
  lines.push(
    "",
    `Do not try to reach ${names} another way, and do not ask anyone to connect a ${names} integration: the app itself is what is missing, and only re-attaching it restores it.`,
  );
  return lines.join("\n");
};

/**
 * The fragment for the presences the agent holds, or null when it holds
 * none (no section at all — silence, not an empty heading).
 */
export const channelsFragment = (
  presences: readonly AgentChannelPresenceWire[],
): CapabilityFragment | null => {
  if (presences.length === 0) return null;
  const live = presences.filter(isLive);
  return {
    id: "channels",
    title: "Where you talk",
    body:
      live.length > 0
        ? liveSection(live)
        : removedSection(presences.filter((p) => !isLive(p))),
  };
};

/**
 * One line for the turn that follows a mid-conversation surface change, so
 * the CONVERSATION says what changed, not only the re-rendered doc. Seen on
 * a real container: after a removal the transcript held two turns of "my
 * Slack app was removed"; a re-attach refreshed the doc, yet the model kept
 * answering from those recent turns. The note travels as the turn's context
 * (the same slot the platform uses for "This is a direct conversation
 * with…"), so it is in the model's most recent input, where it wins.
 */
export const channelsChangeNote = (
  before: readonly AgentChannelPresenceWire[],
  after: readonly AgentChannelPresenceWire[],
): string | null => {
  const liveNames = (list: readonly AgentChannelPresenceWire[]) =>
    new Set(list.filter(isLive).map((p) => displayOf(p.provider).name));
  const wasLive = liveNames(before);
  const nowLive = liveNames(after);
  const gained = [...nowLive].filter((n) => !wasLive.has(n));
  const lost = [...wasLive].filter((n) => !nowLive.has(n));
  const lines: string[] = [];
  for (const name of gained) {
    const presence = after.find(
      (p) => isLive(p) && displayOf(p.provider).name === name,
    );
    lines.push(
      `Your ${name} app${presence ? whereOf(presence, displayOf(presence.provider)) : ""} is attached and live again as of now. Anything earlier in this conversation about it being removed or unavailable is out of date: you are reachable on ${name} and its messaging tools work.`,
    );
  }
  for (const name of lost) {
    lines.push(
      `Your ${name} app was just removed from the workspace (uninstalled, or its access revoked). You cannot send or receive ${name} messages until it is re-attached from your Channels page in the OneCLI dashboard; its messaging tools no longer work, do not call them.`,
    );
  }
  if (lines.length === 0) return null;
  return `[Platform notice] ${lines.join(" ")}`;
};

/**
 * The messaging tools — present exactly when a LIVE presence exists. The
 * descriptions name the platform so the model connects "send on Slack" to
 * the tool, not to the gateway.
 */
export const channelsTools = (
  presences: readonly AgentChannelPresenceWire[],
): PlatformToolDefinition[] => {
  const live = presences.filter(isLive);
  if (live.length === 0) return [];
  const platforms = platformNamesOf(live, " or ");
  return [
    {
      name: "send_message",
      description: `Send a message to a person (DM) or a channel in your ${platforms} workspace, outside this conversation. Delivery may need the workspace owner's one-time approval: the result says "sent" (delivered) or "held" (owner asked; the decision arrives as a notice in this conversation). Use the exact name from find_recipient or the Mentionable list; prefix # for a channel.`,
      inputSchema: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description:
              "The recipient: a person's exact name (e.g. 'Tomer Sharon') or a #channel (e.g. '#general').",
          },
          text: {
            type: "string",
            description:
              "The message, in markdown. Sent as written - the owner sees exactly this text when approval is needed.",
          },
        },
        required: ["to", "text"],
      },
    },
    {
      name: "find_recipient",
      description: `Search your ${platforms} workspace for a person or channel by approximate name. Results include the exact @[Name] form to write in your reply - a person form pings that person, a channel form renders a clickable channel link. Use when someone asks you to tag, mention, link, or contact a person or channel whose exact name you don't have.`,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "The name to search for, as given (e.g. 'tomer', 'Dan A', '#general'). A leading # searches channels.",
          },
          kind: {
            type: "string",
            enum: ["person", "channel"],
            description:
              "What to search. Defaults to person; a query starting with # implies channel.",
          },
        },
        required: ["query"],
      },
    },
  ];
};
