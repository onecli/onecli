import { describe, expect, it } from "vitest";
import type { AgentChannelPresence, AgentContact } from "@/lib/api";
import { mergeChannels, mergePeople, namesOf } from "./merge-contacts";

/**
 * The merge is the fix: the same human used to render twice ("@akim" from
 * the inbound reach row, "Alex Kim" from the outbound address book). Both
 * records carry the provider id, so they must land on ONE entry; anything
 * present on only one side still gets its own entry with the other half
 * null; and kinds never cross (a channel contact is not a person).
 */

const presence = (
  people: { ref: string; label: string | null }[],
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
    })),
    spaces: spaces.map((s) => ({
      externalRef: s.ref,
      label: s.label,
      state: "approved",
      decidedAt: null,
    })),
  }) as unknown as AgentChannelPresence;

const contact = (
  kind: AgentContact["kind"],
  ref: string,
  displayName: string,
): AgentContact => ({
  id: `c-${ref}`,
  kind,
  externalRef: ref,
  displayName,
  policy: "allow",
  updatedAt: "2026-10-01T00:00:00Z",
});

describe("mergePeople", () => {
  it("one entry per Slack user: the reach row and the contact merge on the id", () => {
    const merged = mergePeople(
      [presence([{ ref: "U1", label: "@akim" }])],
      [contact("person", "U1", "Alex Kim")],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.reach?.value.externalRef).toBe("U1");
    expect(merged[0]!.contact?.id).toBe("c-U1");
  });

  it("a one-sided record still gets its own entry, the other half null", () => {
    const merged = mergePeople(
      [presence([{ ref: "U1", label: "@dana" }])],
      [contact("person", "U2", "Ray")],
    );
    expect(merged.map((e) => e.key)).toEqual(["U1", "U2"]);
    expect(merged[0]!.contact).toBeNull();
    expect(merged[1]!.reach).toBeNull();
  });

  it("kinds never cross: channel and app contacts are not people", () => {
    const merged = mergePeople(
      [presence([])],
      [contact("channel", "C1", "#ops"), contact("app", "B1", "Jira")],
    );
    expect(merged).toEqual([]);
  });
});

describe("mergeChannels", () => {
  it("merges the channel reach row with the channel contact on the id", () => {
    const merged = mergeChannels(
      [presence([], [{ ref: "C1", label: "#team" }])],
      [contact("channel", "C1", "#team"), contact("person", "U1", "Alex Kim")],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.contact?.id).toBe("c-C1");
  });
});

describe("namesOf", () => {
  it("the real name is the title and the handle the subtitle", () => {
    const [entry] = mergePeople(
      [presence([{ ref: "U1", label: "@alexk" }])],
      [contact("person", "U1", "Alex Kim")],
    );
    expect(namesOf(entry!)).toEqual({ title: "Alex Kim", subtitle: "@alexk" });
  });

  it("drops the subtitle when it only repeats the title", () => {
    const [entry] = mergePeople(
      [presence([{ ref: "U1", label: "@alex" }])],
      [contact("person", "U1", "Alex")],
    );
    expect(namesOf(entry!)).toEqual({ title: "Alex", subtitle: null });
  });

  it("falls back to the handle, then the raw id", () => {
    const [handleOnly] = mergePeople(
      [presence([{ ref: "U1", label: "@dana" }])],
      [],
    );
    expect(namesOf(handleOnly!).title).toBe("@dana");
    const [idOnly] = mergePeople([presence([{ ref: "U9", label: null }])], []);
    expect(namesOf(idOnly!).title).toBe("U9");
  });
});
