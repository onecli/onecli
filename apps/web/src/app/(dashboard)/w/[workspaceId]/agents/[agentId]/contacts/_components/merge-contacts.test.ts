import { describe, expect, it } from "vitest";
import type { AgentChannelPresence } from "@/lib/api";
import { mergeChannels, mergePeople, nameOf } from "./merge-contacts";

/**
 * One entry per provider id: a person or channel carried by several live
 * presences shows once, and people and channels never cross.
 */

const presence = (
  people: { ref: string; label: string | null; isOwner?: boolean }[],
  spaces: { ref: string; label: string | null }[] = [],
): AgentChannelPresence =>
  ({
    provider: "slack",
    status: "active",
    people: people.map((p) => ({
      externalRef: p.ref,
      label: p.label,
      state: "approved",
      decidedAt: null,
      isOwner: p.isOwner ?? false,
    })),
    spaces: spaces.map((s) => ({
      externalRef: s.ref,
      label: s.label,
      state: "approved",
      decidedAt: null,
    })),
  }) as unknown as AgentChannelPresence;

describe("mergePeople", () => {
  it("one entry per Slack user, even across presences", () => {
    const merged = mergePeople([
      presence([{ ref: "U1", label: "dana" }]),
      presence([
        { ref: "U1", label: "dana" },
        { ref: "U2", label: "ray" },
      ]),
    ]);
    expect(merged.map((e) => e.key)).toEqual(["U1", "U2"]);
  });

  it("workspace owners are always first, whichever presence carries them", () => {
    const merged = mergePeople([
      presence([{ ref: "U1", label: "dana" }]),
      presence([
        { ref: "U2", label: "ray" },
        { ref: "U-OWNER", label: "olive", isOwner: true },
      ]),
    ]);
    expect(merged.map((e) => e.key)).toEqual(["U-OWNER", "U1", "U2"]);
  });

  it("channels are not people", () => {
    expect(mergePeople([presence([], [{ ref: "C1", label: "#ops" }])])).toEqual(
      [],
    );
  });
});

describe("mergeChannels", () => {
  it("one entry per channel; people are not channels", () => {
    const merged = mergeChannels([
      presence([{ ref: "U1", label: "dana" }], [{ ref: "C1", label: "#team" }]),
    ]);
    expect(merged.map((e) => e.key)).toEqual(["C1"]);
  });
});

describe("nameOf", () => {
  it("the label is the name, falling back to the raw id", () => {
    const [labelled] = mergePeople([presence([{ ref: "U1", label: "dana" }])]);
    expect(nameOf(labelled!)).toBe("dana");
    const [idOnly] = mergePeople([presence([{ ref: "U9", label: null }])]);
    expect(nameOf(idOnly!)).toBe("U9");
  });
});
