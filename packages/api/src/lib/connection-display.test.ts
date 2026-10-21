import { describe, expect, it } from "vitest";
import { connectionTags, reconnectLabel } from "./connection-display";

describe("reconnectLabel", () => {
  const alice = { email: "alice@example.com" };
  const bob = { email: "bob@example.com" };

  it("follows the account when the label is the provider's name for it", () => {
    expect(
      reconnectLabel({ label: "alice@example.com", metadata: alice }, bob),
    ).toBe("bob@example.com");
  });

  it("keeps a name the user chose", () => {
    expect(reconnectLabel({ label: "Work mail", metadata: alice }, bob)).toBe(
      "Work mail",
    );
  });

  it("keeps the label when the reconnect carries no identity", () => {
    expect(
      reconnectLabel(
        { label: "alice@example.com", metadata: alice },
        undefined,
      ),
    ).toBe("alice@example.com");
    expect(reconnectLabel({ label: "Work mail", metadata: alice }, {})).toBe(
      "Work mail",
    );
  });

  it("names an unlabeled connection after the account", () => {
    expect(reconnectLabel({ label: null, metadata: null }, bob)).toBe(
      "bob@example.com",
    );
  });

  it("treats stored metadata of any other JSON shape as no identity", () => {
    // A label with no recorded identity behind it was the user's choice.
    for (const metadata of [null, "x", 3, ["alice@example.com"]]) {
      expect(reconnectLabel({ label: "Ops", metadata }, bob)).toBe("Ops");
    }
  });
});

describe("connectionTags", () => {
  it("reads string tags and drops anything else", () => {
    expect(connectionTags({ tags: ["web", 3, "api", null] })).toEqual([
      "web",
      "api",
    ]);
  });

  it("is empty for metadata without tags or of another shape", () => {
    for (const metadata of [null, undefined, "tags", [], { tags: "web" }]) {
      expect(connectionTags(metadata)).toEqual([]);
    }
  });
});
