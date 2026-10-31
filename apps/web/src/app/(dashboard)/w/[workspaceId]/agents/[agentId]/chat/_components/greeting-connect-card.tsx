"use client";

import { memo, useMemo } from "react";
import { useParams } from "next/navigation";
import { getApp } from "@onecli/api/apps/registry";
import type { AppDefinition } from "@onecli/api/apps/types";
import { useAgentChannels } from "@/hooks/use-channels";
import {
  ConnectorSuggestionsCard,
  type ChannelSuggestion,
} from "./connect-suggestions";

/**
 * The first things a new user is nudged to set up. Editorial, not derived:
 * apps most people recognise on sight and can connect in under a minute.
 * Unknown ids (a renamed provider) drop out rather than crash.
 *
 * Two shapes, one card:
 * - `welcome` (the empty thread of any new agent): Gmail and GitHub to work
 *   with, Slack as the place to TALK to the agent (a channel install, not a
 *   credential), and the consent line and catalog footer.
 * - `greeting` (under the onboarding agent's own first message): Gmail only,
 *   as a bare row. The agent's message just asked for Gmail, and the
 *   "Add different tools" button beside it is the catalog door there.
 *
 * Either way: one click, auto-granted to this agent, the same path a connect
 * link in any answer takes.
 */
export const WELCOME_APP_IDS = ["gmail", "github"] as const;
export const GREETING_APP_IDS = ["gmail"] as const;

// Slack is a channel provider, not a registry app (#1096 removed the gateway
// app), so it is named here directly. The icon is the same asset the Channels
// page uses; the provider module itself is not imported because it drags the
// whole Channels UI into the chat bundle.
export const GREETING_CHANNEL: ChannelSuggestion = {
  id: "slack",
  name: "Slack",
  icon: "/icons/slack.svg",
  label: "Chat with this agent from Slack.",
};

/** Hoisted: a fresh `[]` per render would defeat the memo on the card. */
const NO_CHANNELS: ChannelSuggestion[] = [];
const WELCOME_CHANNELS: ChannelSuggestion[] = [GREETING_CHANNEL];

/**
 * Memoized for the same reason `ConnectorSuggestions` is: the greeting
 * variant mounts inside a turn block that re-renders on every stream read,
 * and the card underneath pulls live queries (connections, grants,
 * channels). The one prop is a string literal, so the memo holds.
 */
export const GreetingConnectCard = memo(
  ({ variant }: { variant: "welcome" | "greeting" }) => {
    const greeting = variant === "greeting";
    const suggestions = useMemo(
      () =>
        (greeting ? GREETING_APP_IDS : WELCOME_APP_IDS).flatMap((id) => {
          const app: AppDefinition | undefined = getApp(id);
          return app ? [{ app, kind: "connect" as const }] : [];
        }),
      [greeting],
    );
    // The agent whose chat this is already has Slack → drop the row.
    // Offering "Set up" for something already set up is the one thing this
    // card must not do, and every app row beside it is state-aware for the
    // same reason. An unresolved (or failed) query keeps the row: the
    // suggestion is cheap and a false "already done" would hide the door.
    //
    // The id comes from the route, like `ConnectorSuggestionsCard`'s own
    // auto-grant target. An empty id (the greeting variant offers no
    // channel) disables the query rather than firing a doomed request.
    const params = useParams<{ agentId?: string }>();
    const { data: channelsView } = useAgentChannels(
      greeting ? "" : (params?.agentId ?? ""),
    );
    const slackAttached = (channelsView?.presences ?? []).some(
      (presence) => presence.provider === GREETING_CHANNEL.id,
    );
    const channels = greeting || slackAttached ? NO_CHANNELS : WELCOME_CHANNELS;

    if (suggestions.length === 0 && channels.length === 0) return null;
    return (
      <div
        data-testid="greeting-connect-card"
        className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300"
      >
        <ConnectorSuggestionsCard
          suggestions={suggestions}
          channels={channels}
          hideHeader
          bare={greeting}
        />
      </div>
    );
  },
);
GreetingConnectCard.displayName = "GreetingConnectCard";
