import { beforeEach, describe, expect, it, vi } from "vitest";

const usersConversations = vi.hoisted(() => vi.fn());
const conversationsList = vi.hoisted(() => vi.fn());
vi.mock("@onecli/channels/slack", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@onecli/channels/slack")>()),
  usersConversations,
  conversationsList,
}));

const { slackProvider } = await import("./provider");

const creds = JSON.stringify({ botToken: "xoxb-test" });
const page = (
  channels: {
    id: string;
    name: string;
    is_private?: boolean;
    is_member?: boolean;
  }[],
  next?: string,
) => ({ channels, response_metadata: { next_cursor: next ?? "" } });

/** Finding a channel by name: the bot's own channels (users.conversations)
 *  come first, so one it is in is found even when the workspace has more
 *  channels than the bounded conversations.list walk can reach. */
describe("slackProvider.listChannels", () => {
  beforeEach(() => {
    usersConversations.mockReset();
    conversationsList.mockReset();
  });

  it("returns the bot's own channels as members, before the workspace walk", async () => {
    usersConversations.mockResolvedValue(
      page([{ id: "C9", name: "ops-alerts", is_private: true }]),
    );
    conversationsList.mockResolvedValue(
      page([
        { id: "C1", name: "general", is_member: false },
        { id: "C9", name: "ops-alerts", is_member: false },
      ]),
    );

    const channels = await slackProvider.listChannels({
      credentialsJson: creds,
    });

    expect(channels).toEqual([
      { ref: "C9", name: "ops-alerts", member: true, private: true },
      { ref: "C1", name: "general", member: false, private: false },
    ]);
    expect(usersConversations).toHaveBeenCalledWith("xoxb-test", {
      cursor: undefined,
      limit: 999,
      types: ["public_channel", "private_channel"],
    });
    expect(conversationsList).toHaveBeenCalledWith("xoxb-test", {
      cursor: undefined,
      limit: 999,
    });
  });

  it("finds a member channel the 25-page workspace walk never reaches", async () => {
    usersConversations.mockResolvedValue(page([{ id: "C9", name: "deals" }]));
    // Every workspace page has a next cursor: the walk hits its bound.
    let n = 0;
    conversationsList.mockImplementation(async () => {
      n += 1;
      return page([{ id: `CW${n}`, name: `noise-${n}` }], "more");
    });

    const channels = await slackProvider.listChannels({
      credentialsJson: creds,
    });

    expect(conversationsList).toHaveBeenCalledTimes(25);
    expect(channels.find((c) => c.name === "deals")).toEqual({
      ref: "C9",
      name: "deals",
      member: true,
      private: false,
    });
  });

  it("skips the workspace walk when an own channel satisfies the search", async () => {
    usersConversations.mockResolvedValue(page([{ id: "C9", name: "deals" }]));

    const channels = await slackProvider.listChannels({
      credentialsJson: creds,
      enough: (name) => name === "deals",
    });

    expect(conversationsList).not.toHaveBeenCalled();
    expect(channels).toHaveLength(1);
  });

  it("pages the bot's own channels", async () => {
    usersConversations
      .mockResolvedValueOnce(page([{ id: "C1", name: "a" }], "next"))
      .mockResolvedValueOnce(page([{ id: "C2", name: "b" }]));
    conversationsList.mockResolvedValue(page([]));

    const channels = await slackProvider.listChannels({
      credentialsJson: creds,
    });

    expect(channels.map((c) => c.ref)).toEqual(["C1", "C2"]);
    expect(usersConversations).toHaveBeenLastCalledWith(
      "xoxb-test",
      expect.objectContaining({ cursor: "next" }),
    );
  });

  it("keeps the bot's own channels when the workspace walk fails", async () => {
    usersConversations.mockResolvedValue(page([{ id: "C9", name: "deals" }]));
    conversationsList.mockRejectedValue(new Error("ratelimited"));

    await expect(
      slackProvider.listChannels({ credentialsJson: creds }),
    ).resolves.toEqual([
      { ref: "C9", name: "deals", member: true, private: false },
    ]);
  });

  it("falls back to the workspace walk when the own-channels read fails", async () => {
    usersConversations.mockRejectedValue(new Error("ratelimited"));
    conversationsList.mockResolvedValue(
      page([{ id: "C1", name: "general", is_member: true }]),
    );

    await expect(
      slackProvider.listChannels({ credentialsJson: creds }),
    ).resolves.toEqual([
      { ref: "C1", name: "general", member: true, private: false },
    ]);
  });

  it("an empty answer from a live token is empty, not the other read's error", async () => {
    usersConversations.mockRejectedValue(new Error("ratelimited"));
    conversationsList.mockResolvedValue(page([]));

    await expect(
      slackProvider.listChannels({ credentialsJson: creds }),
    ).resolves.toEqual([]);
  });

  it("still throws when neither read answers (dead-token contract)", async () => {
    usersConversations.mockRejectedValue(new Error("invalid_auth"));
    conversationsList.mockRejectedValue(new Error("invalid_auth"));

    await expect(
      slackProvider.listChannels({ credentialsJson: creds }),
    ).rejects.toThrow("invalid_auth");
  });
});
