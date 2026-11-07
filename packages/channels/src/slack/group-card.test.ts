import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { APPROVAL_GROUP_MAX_IDS } from "../approval-group";
import {
  GROUP_APPROVE_ACTION,
  GROUP_DENY_ACTION,
  GROUP_ROW_ACTION,
  groupClickOf,
  packGroupIds,
  rowActionId,
  unpackGroupIds,
} from "./group-card";

describe("grouped approval card buttons", () => {
  it("round-trips the ids a card showed", () => {
    const ids = ["a1-b2", "c_3", "d4"];
    expect(unpackGroupIds(packGroupIds(ids)!)).toEqual(ids);
  });

  it("a full card of gateway ids fits Slack's limits", () => {
    // The gateway mints UUIDs. A button value caps at 2,000 chars and an
    // overflow option's value at 150 (Slack Block Kit reference).
    const ids = Array.from({ length: APPROVAL_GROUP_MAX_IDS }, () =>
      randomUUID(),
    );
    const value = packGroupIds(ids);
    expect(value?.length).toBeLessThanOrEqual(2_000);
    expect(unpackGroupIds(value!)).toEqual(ids);
    expect(`approve|${ids[0]}`.length).toBeLessThanOrEqual(150);
  });

  it("refuses ids that could smuggle anything into a value", () => {
    for (const bad of [["a,b"], ["a|b"], ["<!here>"], ["x".repeat(65)], []]) {
      expect(packGroupIds(bad)).toBeNull();
    }
    expect(
      packGroupIds(Array.from({ length: 51 }, (_, i) => `id${i}`)),
    ).toBeNull();
    for (const bad of ["", "a,,b", "a,<b>", "x".repeat(2_001)]) {
      expect(unpackGroupIds(bad)).toBeNull();
    }
  });

  it("classifies Approve all, Deny all, and a row's menu choice", () => {
    expect(
      groupClickOf({ action_id: GROUP_APPROVE_ACTION, value: "a,b" }),
    ).toEqual({ approvalIds: ["a", "b"], decision: "approve" });
    expect(groupClickOf({ action_id: GROUP_DENY_ACTION, value: "a" })).toEqual({
      approvalIds: ["a"],
      decision: "deny",
    });
    expect(
      groupClickOf({
        action_id: GROUP_ROW_ACTION,
        selected_option: { value: "deny|a7" },
      }),
    ).toEqual({ approvalIds: ["a7"], decision: "deny" });
    expect(
      groupClickOf({
        action_id: rowActionId(3),
        selected_option: { value: "approve|a8" },
      }),
    ).toEqual({ approvalIds: ["a8"], decision: "approve" });
    expect(
      groupClickOf({
        action_id: GROUP_ROW_ACTION,
        selected_option: { value: "approve_always|a7" },
      }),
    ).toBeNull();
    for (const malformed of ["approve|a7|a8", "approve|", "approve", ""]) {
      expect(
        groupClickOf({
          action_id: rowActionId(0),
          selected_option: { value: malformed },
        }),
      ).toBeNull();
    }
    expect(
      groupClickOf({ action_id: "channel_approve", value: "a" }),
    ).toBeNull();
  });
});
