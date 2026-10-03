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
 * The first things a new user is nudged to set up, rendered under the
 * agent's greeting turn. Editorial, not derived: two apps most people
 * recognise on sight and can connect in under a minute, plus Slack as the
 * place to TALK to the agent (a channel install, not a credential). Unknown
 * ids (a renamed provider) drop out rather than crash.
 *
 * The greeting itself is the agent's own words (greeting-service posts the
 * instruction, the agent answers live); this card is the web's contribution:
 * one click per pick, auto-granted to this agent, the same path a connect
 * link in any answer takes.
 */
export const GREETING_APP_IDS = ["gmail", "github"] as const;

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
const GREETING_CHANNELS: ChannelSuggestion[] = [GREETING_CHANNEL];

/**
 * Memoized for the same reason `ConnectorSuggestions` is: this mounts inside
 * a turn block that re-renders on every stream read, and the card underneath
 * pulls live queries (connections, grants, channels). The component takes no
 * props, so the memo is total.
 */
export const GreetingConnectCard = memo(() => {
  const suggestions = useMemo(
    () =>
      GREETING_APP_IDS.flatMap((id) => {
        const app: AppDefinition | undefined = getApp(id);
        return app ? [{ app, kind: "connect" as const }] : [];
      }),
    [],
  );
  // The agent whose chat this is already has Slack → drop the row. Offering
  // "Set up" for something already set up is the one thing this card must
  // not do, and every app row beside it is state-aware for the same reason.
  // An unresolved (or failed) query keeps the row: the suggestion is cheap
  // and a false "already done" would hide the door entirely.
  //
  // The id comes from the route, like `ConnectorSuggestionsCard`'s own
  // auto-grant target — the card only renders inside /agents/[agentId], and
  // an empty id disables the query rather than firing a doomed request.
  const params = useParams<{ agentId?: string }>();
  const { data: channelsView } = useAgentChannels(params?.agentId ?? "");
  const slackAttached = (channelsView?.presences ?? []).some(
    (presence) => presence.provider === GREETING_CHANNEL.id,
  );
  const channels = slackAttached ? NO_CHANNELS : GREETING_CHANNELS;

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
      />
    </div>
  );
});
GreetingConnectCard.displayName = "GreetingConnectCard";
