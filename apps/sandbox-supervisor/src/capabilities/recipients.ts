import type { CapabilityFragment } from "../home/renderer";
import type { PlatformToolDefinition } from "../platform-tools";

/**
 * The recipients capability — the discovery half of the mention design
 * (roadmap PR 3). The mention note teaches the `@[Name]` grammar per
 * conversation; this fragment teaches DISCOVERY: how to find someone's
 * exact name (or a channel) when the person asked for isn't on the
 * mentionable list, and how a pick becomes a real ping.
 *
 * Control-plane executed (no local `execute`): the search needs the DB, the
 * provider roster, and the tenant fence — none of which live in this
 * container.
 */

export const recipientsFragment: CapabilityFragment = {
  id: "recipients",
  title: "Finding people and channels",
  body: `You work on chat platforms where people and channels have exact
names you may not know. When you need to mention someone and their exact
name is not in the conversation's Mentionable list, use find_recipient to
search the connected workspace by approximate name.

- Write the mention form a result gives you and the platform turns it into
  a real ping of that exact person. That's the whole flow: find, tag, done.
- Channels work the same way: a channel result's mention form renders as a
  clickable channel link in your reply.
- Results marked kind: app are Slack apps. Write @[app] with your
  message in a channel reply to invoke the app right there. Only write
  @[app] when you intend to invoke it; as prose, use the bare name.

You can also message people and channels directly with send_message —
outside the current conversation, on your own initiative or when asked.
Use the recipient's exact name (a find_recipient result or the
Mentionable list); #channel-name reaches a channel.

- "sent" = delivered. "held" = the workspace owner was asked first; the
  decision arrives as a notice at the start of a later turn, so never
  promise to follow up on your own.`,
};

export const recipientsTools: PlatformToolDefinition[] = [
  {
    name: "send_message",
    description:
      'Send a message to a person (DM) or a channel in the connected chat workspace, outside this conversation. Delivery may need the workspace owner\'s one-time approval: the result says "sent" (delivered) or "held" (owner asked; the decision arrives as a notice in this conversation). Use the exact name from find_recipient or the Mentionable list; prefix # for a channel.',
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
    description:
      "Search the connected chat workspace for a person or channel by approximate name. Results include the exact @[Name] form to write in your reply - a person form pings that person, a channel form renders a clickable channel link. Use when someone asks you to tag, mention, link, or contact a person or channel whose exact name you don't have.",
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
