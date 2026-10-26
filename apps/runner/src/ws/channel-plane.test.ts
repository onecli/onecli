import { describe, expect, it } from "vitest";
import type { RunnerSandboxesResponse } from "@onecli/agent-protocol";
import { createChannelPlane } from "./channel-plane";

/**
 * The ws server's view of the control plane's channel records. Two jobs
 * beyond passing calls through:
 *
 * - A release must eventually land: if it is lost, the control plane keeps
 *   naming this copy as the holder of a socket that is gone, and the
 *   sandbox's turns wait for the reconciler instead of the reconnect.
 *   Retried with backoff, and dropped once it is moot.
 * - Many sockets reconnecting at once (a copy rolled under a hundred
 *   sandboxes) must not cost a hundred listings: concurrent container
 *   lookups share one.
 */

const listing = (
  containers: Record<string, string>,
): RunnerSandboxesResponse => ({
  sandboxIds: Object.keys(containers),
  channels: Object.fromEntries(
    Object.entries(containers).map(([id, ref]) => [
      id,
      { containerRef: ref, channel: "held", since: 1 },
    ]),
  ),
  reconciler: false,
});

const instant = () => Promise.resolve();

describe("container lookup", () => {
  it("answers the container the control plane records, and shares one listing between concurrent lookups", async () => {
    let lists = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const plane = createChannelPlane({
      client: {
        claimChannel: async () => null,
        releaseChannel: async () => undefined,
        listAssignedSandboxes: async () => {
          lists += 1;
          await gate;
          return listing({ "sb-1": "ctr-1", "sb-2": "ctr-2" });
        },
      },
      sleep: instant,
    });
    const answers = Promise.all([
      plane.containerOf("sb-1"),
      plane.containerOf("sb-2"),
      plane.containerOf("sb-3"),
    ]);
    open();
    expect(await answers).toEqual(["ctr-1", "ctr-2", undefined]);
    expect(lists).toBe(1);
    // Once settled, the next lookup asks again (never a stale answer).
    await plane.containerOf("sb-1");
    expect(lists).toBe(2);
  });

  it("throws when the control plane cannot be asked (the caller then trusts only what it verified)", async () => {
    const plane = createChannelPlane({
      client: {
        claimChannel: async () => null,
        releaseChannel: async () => undefined,
        listAssignedSandboxes: async () => {
          throw new Error("down");
        },
      },
      sleep: instant,
    });
    await expect(plane.containerOf("sb-1")).rejects.toThrow("down");
  });
});

describe("release", () => {
  it("retries a failed release until it lands", async () => {
    const attempts: string[] = [];
    let failures = 2;
    const plane = createChannelPlane({
      client: {
        claimChannel: async () => null,
        listAssignedSandboxes: async () => listing({}),
        releaseChannel: async (connectionId) => {
          attempts.push(connectionId);
          if (failures-- > 0) throw new Error("blip");
        },
      },
      sleep: instant,
    });
    plane.release("conn-1");
    await plane.settled();
    expect(attempts).toEqual(["conn-1", "conn-1", "conn-1"]);
  });

  it("gives up after its budget: the reconciler's grace covers a release that never lands", async () => {
    let attempts = 0;
    const plane = createChannelPlane({
      client: {
        claimChannel: async () => null,
        listAssignedSandboxes: async () => listing({}),
        releaseChannel: async () => {
          attempts += 1;
          throw new Error("down");
        },
      },
      sleep: instant,
      releaseAttempts: 4,
    });
    plane.release("conn-1");
    await plane.settled();
    expect(attempts).toBe(4);
  });

  it("passes claims straight through", async () => {
    const plane = createChannelPlane({
      client: {
        claimChannel: async (claim) =>
          claim.door === "token"
            ? { sandboxId: "sb-1", containerRef: "ctr-1" }
            : null,
        listAssignedSandboxes: async () => listing({}),
        releaseChannel: async () => undefined,
      },
      sleep: instant,
    });
    expect(
      await plane.claim({
        door: "token",
        connectionId: "c",
        connectedAt: 1,
        tokenHash: "a".repeat(64),
      }),
    ).toEqual({ sandboxId: "sb-1", containerRef: "ctr-1" });
  });
});
