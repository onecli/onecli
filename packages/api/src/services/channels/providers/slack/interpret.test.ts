import { describe, expect, it } from "vitest";

import { groupThreadId, interpretSlackEvent } from "./interpret";

/**
 * Slack event → door call classification, pure and mutation-proofed.
 *
 * THE ECHO GUARD tests are the load-bearing ones: `message.im` fires for the
 * bot's own posts too, so any deleted drop below turns the agent's first
 * answer into a new turn and the loop never ends. Each drop is pinned by a
 * test that fails if that specific guard clause is removed.
 */

const BOT = "UBOTSELF";
const CTX = { botUserId: BOT };

const dm = (overrides: Record<string, unknown> = {}) => ({
  type: "message",
  channel: "D0001",
  channel_type: "im",
  user: "U1111",
  text: "hello",
  ts: "1111.0001",
  ...overrides,
});

const channelMessage = (overrides: Record<string, unknown> = {}) => ({
  type: "message",
  channel: "C9999",
  channel_type: "channel",
  user: "U1111",
  text: "in a channel",
  ts: "2222.0001",
  ...overrides,
});

describe("the echo guard", () => {
  it("ignores any bot-authored message (bot_id present)", () => {
    // MUTATION-TESTED: delete the `if (message.bot_id)` drop and this DM —
    // which is otherwise a perfectly shaped user DM — becomes a direct-door
    // call, i.e. the agent answering itself forever.
    expect(interpretSlackEvent(dm({ bot_id: "B123" }), CTX)).toEqual({
      door: "ignore",
      reason: "bot-authored",
    });
  });

  it('ignores subtype "bot_message"', () => {
    // MUTATION-TESTED: some bot posts carry only the subtype (no bot_id on
    // every path) — delete the subtype drop and this loops too.
    expect(
      interpretSlackEvent(
        dm({ subtype: "bot_message", bot_id: undefined }),
        CTX,
      ),
    ).toEqual({ door: "ignore", reason: "subtype:bot_message" });
  });

  it("ignores a message from the presence's OWN user id", () => {
    // MUTATION-TESTED: the third arm of the echo guard — a message authored
    // by identityRef with neither bot_id nor subtype. Delete the
    // own-user drop and the echo loops through this shape.
    expect(interpretSlackEvent(dm({ user: BOT }), CTX)).toEqual({
      door: "ignore",
      reason: "self",
    });
  });

  it.each(["message_changed", "message_deleted", "thread_broadcast"])(
    "ignores subtype %s — edits and deletions are not new turns",
    (subtype) => {
      expect(interpretSlackEvent(dm({ subtype }), CTX)).toEqual({
        door: "ignore",
        reason: `subtype:${subtype}`,
      });
    },
  );

  it("ignores an app_mention authored by the bot itself", () => {
    expect(
      interpretSlackEvent(
        {
          type: "app_mention",
          channel: "C9999",
          user: BOT,
          text: `<@${BOT}> hi`,
          ts: "3333.0001",
        },
        CTX,
      ),
    ).toEqual({ door: "ignore", reason: "self" });
  });

  it("still applies the bot_id/subtype drops when botUserId is unknown", () => {
    // A pending presence has identityRef null — the guard's first two arms
    // must not depend on knowing our own user id.
    const ctx = { botUserId: null };
    expect(interpretSlackEvent(dm({ bot_id: "B123" }), ctx)).toMatchObject({
      door: "ignore",
      reason: "bot-authored",
    });
    expect(
      interpretSlackEvent(dm({ subtype: "bot_message" }), ctx),
    ).toMatchObject({ door: "ignore" });
  });
});

describe("direct messages", () => {
  it("routes a top-level DM (channel_type im) to the direct door, threaded nowhere", () => {
    expect(interpretSlackEvent(dm(), CTX)).toEqual({
      door: "direct",
      externalUserId: "U1111",
      // The DM's thread address is the IM channel itself.
      externalThreadId: "D0001",
      text: "hello",
      files: [],
      replyChannel: "D0001",
      // A DM typed at the top level answers top-level — no thread is opened
      // for it (the card, not the loader, carries the progress there).
      replyThreadTs: null,
      // The triggering message's own ts — the receipt reaction's address.
      messageTs: "1111.0001",
    });
  });

  it("answers a DM reply IN the thread it was typed in", () => {
    // THE BUG THIS FIXES (live): a reply typed inside a DM thread was
    // answered at the bottom of the DM instead, with no progress shown in
    // the thread — because the direct door hardcoded `replyThreadTs: null`
    // and discarded the event's `thread_ts`.
    //
    // MUTATION-PROOF: restore `replyThreadTs: null` on the direct door and
    // this fails.
    expect(
      interpretSlackEvent(dm({ thread_ts: "1111.0001", ts: "1111.0009" }), CTX),
    ).toMatchObject({
      door: "direct",
      replyChannel: "D0001",
      replyThreadTs: "1111.0001",
      messageTs: "1111.0009",
    });
  });

  it("keeps a threaded DM on the SAME conversation as the DM itself", () => {
    // §3.18: a user's DM is ONE thread — the same row their web chat reads.
    // Threads inside it change WHERE the answer goes, never which
    // conversation it belongs to. MUTATION-PROOF: address a DM thread as its
    // own `<channel>:<ts>` conversation and this fails.
    const threaded = interpretSlackEvent(
      dm({ thread_ts: "1111.0001", ts: "1111.0009" }),
      CTX,
    );
    expect(threaded).toMatchObject({ externalThreadId: "D0001" });
    expect(threaded).toMatchObject({
      externalThreadId: (
        interpretSlackEvent(dm(), CTX) as { externalThreadId: string }
      ).externalThreadId,
    });
  });

  it("ignores a message with no speaker at all", () => {
    expect(interpretSlackEvent(dm({ user: undefined }), CTX)).toEqual({
      door: "ignore",
      reason: "no-speaker",
    });
  });
});

describe("group surfaces", () => {
  it("routes a top-level app_mention to the group door, rooting a thread at itself", () => {
    expect(
      interpretSlackEvent(
        {
          type: "app_mention",
          channel: "C9999",
          user: "U1111",
          text: `<@${BOT}> deploy please`,
          ts: "4444.0001",
        },
        CTX,
      ),
    ).toEqual({
      door: "group",
      externalUserId: "U1111",
      externalThreadId: "C9999:4444.0001",
      text: `<@${BOT}> deploy please`,
      files: [],
      replyChannel: "C9999",
      replyThreadTs: "4444.0001",
      messageTs: "4444.0001",
      isMention: true,
    });
  });

  it("roots an app_mention INSIDE a thread at the thread's own root", () => {
    const call = interpretSlackEvent(
      {
        type: "app_mention",
        channel: "C9999",
        user: "U1111",
        text: "follow-up mention",
        ts: "4444.0009",
        thread_ts: "4444.0001",
      },
      CTX,
    );
    expect(call).toMatchObject({
      door: "group",
      externalThreadId: "C9999:4444.0001",
      replyThreadTs: "4444.0001",
    });
  });

  it("ignores a plain channel message with no thread — channel chatter", () => {
    expect(interpretSlackEvent(channelMessage(), CTX)).toEqual({
      door: "ignore",
      reason: "channel-chatter",
    });
  });

  it("routes a thread follow-up (no mention) to the group door", () => {
    // Whether the thread is actually joined is the dispatcher's link check;
    // classification itself must hand the follow-up over.
    expect(
      interpretSlackEvent(channelMessage({ thread_ts: "2222.0000" }), CTX),
    ).toEqual({
      door: "group",
      externalUserId: "U1111",
      externalThreadId: "C9999:2222.0000",
      text: "in a channel",
      files: [],
      replyChannel: "C9999",
      replyThreadTs: "2222.0000",
      // The follow-up's OWN ts, not the thread root's.
      messageTs: "2222.0001",
      isMention: false,
    });
  });

  it("groupThreadId is `<channel>:<threadRootTs>`", () => {
    expect(groupThreadId("C1", "9.9")).toBe("C1:9.9");
  });
});

describe("the mention twin (double-delivery guard)", () => {
  it("drops a channel message that mentions the bot — the app_mention twin is authoritative", () => {
    // MUTATION-TESTED: Slack delivers a channel mention as BOTH an app_mention
    // AND a message.channels event, with distinct event_ids the dedupe can't
    // collapse. Delete this drop and the message twin becomes a SECOND turn —
    // which 409s into a spurious "still working" reply on every in-thread
    // mention. Without the guard this threaded message would route to the group
    // door (a real door call), so `ignore` here is the proof it was dropped.
    expect(
      interpretSlackEvent(
        channelMessage({
          text: `hey <@${BOT}> deploy`,
          thread_ts: "2222.0000",
        }),
        CTX,
      ),
    ).toEqual({ door: "ignore", reason: "mention-twin" });
  });

  it("the app_mention carrying the same text still routes to the group door", () => {
    // The AUTHORITATIVE twin is never dropped — exactly one turn results.
    expect(
      interpretSlackEvent(
        {
          type: "app_mention",
          channel: "C9999",
          user: "U1111",
          text: `hey <@${BOT}> deploy`,
          ts: "2222.0000",
        },
        CTX,
      ),
    ).toMatchObject({
      door: "group",
      externalThreadId: "C9999:2222.0000",
      text: `hey <@${BOT}> deploy`,
    });
  });

  it("NEVER fires on a DM — an IM has no app_mention twin to defer to", () => {
    // MUTATION-TESTED (guard ORDER, not existence): the IM branch must run
    // BEFORE the mention-twin drop. Move the drop above it and a user typing
    // the bot's own @ inside its 1:1 DM is silently ignored with no reply —
    // there is no app_mention twin in a DM to answer instead.
    expect(
      interpretSlackEvent(dm({ text: `hey <@${BOT}> are you there?` }), CTX),
    ).toMatchObject({
      door: "direct",
      externalThreadId: "D0001",
      text: `hey <@${BOT}> are you there?`,
    });
  });

  it("does not fire when our own identity is unknown (a pending presence)", () => {
    // Guards the `ctx.botUserId &&` half: with no known identity the predicate
    // can't run, so a threaded message falls through to the group door as usual.
    expect(
      interpretSlackEvent(
        channelMessage({
          text: `hey <@${BOT}> deploy`,
          thread_ts: "2222.0000",
        }),
        { botUserId: null },
      ),
    ).toMatchObject({ door: "group" });
  });
});

describe("invites (member_joined_channel)", () => {
  it("treats the BOT joining with an inviter as an invite", () => {
    expect(
      interpretSlackEvent(
        {
          type: "member_joined_channel",
          channel: "C7777",
          user: BOT,
          inviter: "U2222",
        },
        CTX,
      ),
    ).toEqual({
      door: "invite",
      inviterExternalUserId: "U2222",
      channel: "C7777",
    });
  });

  it("carries a NULL inviter when Slack omits it (the doors fail closed on it)", () => {
    expect(
      interpretSlackEvent(
        { type: "member_joined_channel", channel: "C7777", user: BOT },
        CTX,
      ),
    ).toEqual({
      door: "invite",
      inviterExternalUserId: null,
      channel: "C7777",
    });
  });

  it("ignores someone ELSE joining a channel the bot sits in", () => {
    expect(
      interpretSlackEvent(
        {
          type: "member_joined_channel",
          channel: "C7777",
          user: "U3333",
          inviter: "U2222",
        },
        CTX,
      ),
    ).toEqual({ door: "ignore", reason: "someone-else-joined" });
  });

  it("ignores a join when our own identity is unknown — cannot claim invites", () => {
    expect(
      interpretSlackEvent(
        { type: "member_joined_channel", channel: "C7777", user: BOT },
        { botUserId: null },
      ),
    ).toEqual({ door: "ignore", reason: "someone-else-joined" });
  });
});

describe("junk resilience", () => {
  it.each([
    ["a number", 42],
    ["null", null],
    ["a string", "surprise"],
    ["an object with no type", { channel: "C1" }],
  ])("classifies %s as unparseable, never a throw", (_label, raw) => {
    expect(interpretSlackEvent(raw, CTX)).toEqual({
      door: "ignore",
      reason: "unparseable",
    });
  });

  it("classifies an unknown event type as an ignore naming the type", () => {
    expect(interpretSlackEvent({ type: "reaction_added" }, CTX)).toEqual({
      door: "ignore",
      reason: "event:reaction_added",
    });
  });

  it("a malformed message (missing ts) is still an ignore, not a crash", () => {
    // `message` without `ts` fails the strict message schema; the loose
    // passthrough arm still parses it, and the message branch then drops it
    // for having no speaker. Either way: ignored, never a 500.
    expect(
      interpretSlackEvent({ type: "message", channel: "C1" }, CTX),
    ).toEqual({ door: "ignore", reason: "no-speaker" });
  });
});

describe("file_share (attachments)", () => {
  const file = (over: Record<string, unknown> = {}) => ({
    id: "F1",
    name: "photo.png",
    mimetype: "image/png",
    size: 1024,
    url_private: "https://files.slack.com/files-pri/T1-F1/photo.png",
    ...over,
  });

  it("lets a file_share DM through and normalizes its files", () => {
    const call = interpretSlackEvent(
      dm({ subtype: "file_share", text: "what is this?", files: [file()] }),
      CTX,
    );
    expect(call).toMatchObject({ door: "direct", text: "what is this?" });
    if (call.door !== "direct") throw new Error("unreachable");
    expect(call.files).toEqual([
      {
        id: "F1",
        name: "photo.png",
        mimeType: "image/png",
        size: 1024,
        url: "https://files.slack.com/files-pri/T1-F1/photo.png",
        needsInfo: false,
      },
    ]);
  });

  it("still drops a BOT-authored file_share — the echo guard's first arm wins", () => {
    // MUTATION-TESTED: the file_share carve-out must NOT reach past the
    // bot_id drop, or the agent's own file post loops.
    expect(
      interpretSlackEvent(
        dm({ subtype: "file_share", bot_id: "B1", files: [file()] }),
        CTX,
      ),
    ).toEqual({ door: "ignore", reason: "bot-authored" });
  });

  it("still drops a SELF-authored file_share (own user id)", () => {
    expect(
      interpretSlackEvent(
        dm({ subtype: "file_share", user: BOT, files: [file()] }),
        CTX,
      ),
    ).toEqual({ door: "ignore", reason: "self" });
  });

  it("a file-only file_share (no text) still routes to the direct door", () => {
    const call = interpretSlackEvent(
      dm({ subtype: "file_share", text: undefined, files: [file()] }),
      CTX,
    );
    expect(call).toMatchObject({ door: "direct", text: "" });
    if (call.door !== "direct") throw new Error("unreachable");
    expect(call.files).toHaveLength(1);
  });

  it("marks a Slack Connect stub as needsInfo", () => {
    const call = interpretSlackEvent(
      dm({
        subtype: "file_share",
        files: [
          { id: "F9", mode: "file_access", file_access: "check_file_info" },
        ],
      }),
      CTX,
    );
    if (call.door !== "direct") throw new Error("unreachable");
    expect(call.files[0]).toMatchObject({
      id: "F9",
      needsInfo: true,
      url: null,
    });
  });

  it("carries files on an app_mention (Slack mirrors them onto the mention)", () => {
    const call = interpretSlackEvent(
      {
        type: "app_mention",
        channel: "C9999",
        user: "U1111",
        text: `<@${BOT}> see this`,
        files: [file()],
        ts: "5555.0001",
      },
      CTX,
    );
    if (call.door !== "group") throw new Error("unreachable");
    expect(call.files).toHaveLength(1);
  });
});

describe("threaded DM edge cases", () => {
  it("carries a file shared INSIDE a DM thread with its thread", () => {
    // `file_share` is the one subtype that passes the echo guard, and it
    // must keep the thread like any other DM reply — otherwise attachments
    // sent in a thread get answered outside it.
    expect(
      interpretSlackEvent(
        dm({
          subtype: "file_share",
          thread_ts: "1111.0001",
          ts: "1111.0055",
          files: [{ id: "F1", name: "a.png", mimetype: "image/png" }],
        }),
        CTX,
      ),
    ).toMatchObject({
      door: "direct",
      replyThreadTs: "1111.0001",
      files: [{ id: "F1", name: "a.png" }],
    });
  });

  it("still drops the BOT's own threaded DM post (the echo guard wins)", () => {
    // The agent's own answer now lands IN a thread, so it comes back as a
    // threaded `message.im`. If the guard missed it, every threaded answer
    // would start a new turn — an infinite loop in the thread.
    expect(
      interpretSlackEvent(
        dm({ thread_ts: "1111.0001", ts: "1111.0077", bot_id: "B1" }),
        CTX,
      ),
    ).toEqual({ door: "ignore", reason: "bot-authored" });
    expect(
      interpretSlackEvent(
        dm({ thread_ts: "1111.0001", ts: "1111.0078", user: BOT }),
        CTX,
      ),
    ).toEqual({ door: "ignore", reason: "self" });
  });
});
