// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GREETING_APP_IDS,
  GREETING_CHANNEL,
  GreetingConnectCard,
} from "./greeting-connect-card";

// The card pulls live queries (connections, grants); this component's own
// contract is WHICH picks it offers, so the card is a stub here.
const cardProps = vi.hoisted(() => ({ last: null as unknown }));
vi.mock("./connect-suggestions", () => ({
  ConnectorSuggestionsCard: (props: unknown) => {
    cardProps.last = props;
    return <div data-testid="card" />;
  },
}));

const { useAgentChannels } = vi.hoisted(() => ({
  useAgentChannels: vi.fn(),
}));
vi.mock("@/hooks/use-channels", () => ({ useAgentChannels }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ agentId: "agent-1" }),
}));

type CardProps = {
  suggestions: { app: { id: string }; kind: string }[];
  channels: { id: string }[];
  hideHeader: boolean;
};

const rendered = (): CardProps => cardProps.last as CardProps;

afterEach(() => {
  cleanup();
  useAgentChannels.mockReset();
});

describe("<GreetingConnectCard />", () => {
  it("offers Gmail and GitHub as connects and Slack as a channel, headerless", () => {
    useAgentChannels.mockReturnValue({ data: undefined });
    render(<GreetingConnectCard />);
    expect(screen.getByTestId("card")).toBeTruthy();
    const props = rendered();
    expect(props.suggestions.map((s) => s.app.id)).toEqual([
      ...GREETING_APP_IDS,
    ]);
    expect(new Set(props.suggestions.map((s) => s.kind))).toEqual(
      new Set(["connect"]),
    );
    expect(props.channels.map((c) => c.id)).toEqual([GREETING_CHANNEL.id]);
    expect(props.hideHeader).toBe(true);
  });

  it("drops the Slack row once this agent already has Slack", () => {
    // Offering "Set up" for something already set up is the one thing this
    // card must not do — every app row beside it is state-aware.
    useAgentChannels.mockReturnValue({
      data: { presences: [{ provider: "slack" }] },
    });
    render(<GreetingConnectCard />);
    expect(rendered().channels).toEqual([]);
  });

  it("keeps the Slack row while the channels query is unresolved", () => {
    // A false "already done" would hide the door entirely; the suggestion is
    // cheap, so an unknown state keeps it.
    useAgentChannels.mockReturnValue({ data: undefined });
    render(<GreetingConnectCard />);
    expect(rendered().channels.map((c) => c.id)).toEqual([GREETING_CHANNEL.id]);
  });

  it("keeps the Slack row when another provider is attached", () => {
    useAgentChannels.mockReturnValue({
      data: { presences: [{ provider: "teams" }] },
    });
    render(<GreetingConnectCard />);
    expect(rendered().channels.map((c) => c.id)).toEqual([GREETING_CHANNEL.id]);
  });
});
