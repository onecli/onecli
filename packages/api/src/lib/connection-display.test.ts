import { describe, expect, it } from "vitest";
import {
  DATABASE_TLS_TAGS,
  connectionTags,
  connectsAsSuperuser,
  databaseConnectionUrl,
  databaseTlsModeFromTags,
  displayConnectionLabel,
  extractDatabaseTarget,
  findDuplicateConnection,
  parseLegacyDatabaseName,
  reconnectLabel,
  shortDatabaseServer,
} from "./connection-display";

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

describe("connectsAsSuperuser", () => {
  it("is true only when the gateway recorded a superuser login", () => {
    expect(connectsAsSuperuser({ superuser: true })).toBe(true);
    for (const metadata of [
      null,
      undefined,
      {},
      { superuser: false },
      { superuser: "true" },
      [true],
    ]) {
      expect(connectsAsSuperuser(metadata)).toBe(false);
    }
  });
});

describe("database targets", () => {
  const target = {
    host: "db.example.com",
    port: 5432,
    database: "app",
    username: "agent",
  };
  const conn = (label: string, t?: typeof target) => ({
    label,
    metadata: t ? { name: t.database, target: t } : { name: label },
  });

  it("names the server short and keeps the full string to copy", () => {
    const managed = {
      ...target,
      host: "orders-prod.abc123xyz.eu-west-1.example.com",
    };
    expect(shortDatabaseServer(managed)).toBe("orders-prod");
    expect(shortDatabaseServer({ ...target, port: 6543 })).toBe("db:6543");
    expect(shortDatabaseServer({ ...target, host: "10.0.0.5" })).toBe(
      "10.0.0.5",
    );
    expect(databaseConnectionUrl(managed)).toBe(
      "postgresql://agent@orders-prod.abc123xyz.eu-west-1.example.com:5432/app",
    );
    expect(databaseConnectionUrl({ ...target, host: "::1" })).toBe(
      "postgresql://agent@[::1]:5432/app",
    );
  });

  it("shortens only a generated legacy `db on host` label", () => {
    const legacy = "orders on orders-prod.abc123xyz.example.com";
    expect(displayConnectionLabel(legacy, { name: legacy })).toBe("orders");
    // A name the user typed is theirs, even if it has " on " in it.
    expect(displayConnectionLabel("Sales on prod", { name: "app" })).toBe(
      "Sales on prod",
    );
    expect(displayConnectionLabel(null, {})).toBeNull();
    expect(parseLegacyDatabaseName("orders on db.example.com")).toEqual({
      database: "orders",
      host: "db.example.com",
    });
    expect(parseLegacyDatabaseName("orders on 10.0.0.5")).toEqual({
      database: "orders",
      host: "10.0.0.5",
    });
    // Not a host the connect form could have stored, or a name a user typed.
    for (const name of [
      "orders",
      "Sales on prod",
      "Sales on Q3 (prod)",
      "a on b/c",
      42,
    ])
      expect(parseLegacyDatabaseName(name)).toBeNull();
  });

  it("reads a TLS mode back from the tag it was saved with", () => {
    for (const mode of ["verify-full", "require", "disable"] as const)
      expect(databaseTlsModeFromTags([DATABASE_TLS_TAGS[mode]])).toBe(mode);
    expect(databaseTlsModeFromTags([])).toBeNull();
    expect(databaseTlsModeFromTags(["repo-a"])).toBeNull();
  });

  it("ignores malformed metadata", () => {
    expect(extractDatabaseTarget({ target: { host: "h" } })).toBeNull();
    expect(extractDatabaseTarget(null)).toBeNull();
    expect(extractDatabaseTarget({ target })).toEqual(target);
  });

  it("matches a database by login, never by its shared short name", () => {
    const other = { ...target, host: "other.example.com" };
    const existing = [conn("app", other), conn("app", target)];
    expect(
      findDuplicateConnection(existing, "app", { name: "app", target }),
    ).toBe(existing[1]);
    expect(
      findDuplicateConnection([conn("app", other)], "app", {
        name: "app",
        target,
      }),
    ).toBeUndefined();
  });

  it("keeps label matching for every other app", () => {
    const existing = [conn("a@x.com"), conn("b@x.com")];
    expect(findDuplicateConnection(existing, "B@x.com", {})).toBe(existing[1]);
    expect(findDuplicateConnection(existing, null, {})).toBe(existing[0]);
  });
});
