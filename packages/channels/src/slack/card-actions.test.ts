import { describe, expect, it } from "vitest";

import {
  FOLLOW_UP_SEND_NOW_ACTION,
  TURN_STOP_ACTION,
  followUpActionClickOf,
  followUpSendNowButton,
  turnStopButton,
  turnStopClickOf,
} from "./card-actions";

const click = (overrides: Record<string, unknown> = {}) => ({
  type: "block_actions",
  user: { id: "U1" },
  container: { type: "message", channel_id: "D1", message_ts: "1700.1" },
  actions: [{ action_id: TURN_STOP_ACTION, value: "stop" }],
  ...overrides,
});

const sendNowClick = (value: unknown = "fu-1") =>
  click({ actions: [{ action_id: FOLLOW_UP_SEND_NOW_ACTION, value }] });

// Payloads neither classifier accepts, whatever the button.
const notACardClick: [string, unknown][] = [
  ["not block_actions", click({ type: "view_submission" })],
  ["no actions", click({ actions: [] })],
  ["no clicker", click({ user: undefined })],
  ["a view container", click({ container: { type: "view", view_id: "V" } })],
  [
    "no message ts",
    click({ container: { type: "message", channel_id: "D1" } }),
  ],
  [
    "no channel",
    click({ container: { type: "message", message_ts: "1700.1" } }),
  ],
  ["an oversized id", click({ user: { id: "U".repeat(201) } })],
  ["a non-object", "payload"],
  ["null", null],
];

describe("turnStopClickOf", () => {
  it("reads the card's address from the container and the clicker from user", () => {
    expect(turnStopClickOf(click())).toEqual({
      channel: "D1",
      messageTs: "1700.1",
      clickerExternalUserId: "U1",
    });
  });

  it("ignores the button's value entirely (it names nothing)", () => {
    expect(
      turnStopClickOf(
        click({
          actions: [{ action_id: TURN_STOP_ACTION, value: "turn-xyz" }],
        }),
      ),
    ).toEqual(turnStopClickOf(click()));
  });

  it.each([
    ...notACardClick,
    [
      "another button",
      click({ actions: [{ action_id: "action_approve", value: "x" }] }),
    ],
    ["a Send now click", sendNowClick()],
  ])("returns null for %s", (_label, payload) => {
    expect(turnStopClickOf(payload)).toBeNull();
  });

  it("is the quiet default button, not a red one (a rarely used control)", () => {
    expect("style" in turnStopButton).toBe(false);
  });

  it("the rendered button is what the classifier recognizes", () => {
    expect(
      turnStopClickOf(
        click({
          actions: [
            {
              action_id: turnStopButton.action_id,
              value: turnStopButton.value,
            },
          ],
        }),
      ),
    ).not.toBeNull();
  });
});

describe("followUpActionClickOf", () => {
  it("reads the card's address, the clicker, and which message was pressed", () => {
    expect(followUpActionClickOf(sendNowClick())).toEqual({
      channel: "D1",
      messageTs: "1700.1",
      clickerExternalUserId: "U1",
      action: "send_now",
      followUpId: "fu-1",
    });
  });

  it.each([
    ...notACardClick,
    ["a Stop click", click()],
    ["an empty value", sendNowClick("")],
    ["a non-string value", sendNowClick(42)],
    ["an oversized value", sendNowClick("f".repeat(201))],
  ])("returns null for %s", (_label, payload) => {
    expect(followUpActionClickOf(payload)).toBeNull();
  });

  it("the rendered button is what the classifier recognizes", () => {
    const button = followUpSendNowButton("fu-9", "U7");
    expect(
      followUpActionClickOf(
        click({
          actions: [{ action_id: button.action_id, value: button.value }],
        }),
      ),
    ).toMatchObject({ action: "send_now", followUpId: "fu-9" });
  });

  it("is shown only to the message's author, in the quiet default style", () => {
    const button = followUpSendNowButton("fu-9", "U7");
    expect(button.visible_to_user_ids).toEqual(["U7"]);
    expect("style" in button).toBe(false);
  });
});
