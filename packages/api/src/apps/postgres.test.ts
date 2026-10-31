import { describe, expect, it } from "vitest";
import { postgres } from "./postgres";
import { postgresPermissions } from "./app-permissions/postgres";
import { pathMatches } from "../lib/path-match";
import { extractDatabaseTarget } from "../lib/connection-display";

const resolve =
  postgres.connectionMethod.type === "api_key"
    ? postgres.connectionMethod.resolveMetadata
    : undefined;
if (!resolve) throw new Error("postgres must validate its connect form");

const valid = {
  password: "s3cret",
  host: "db.example.com",
  port: "5432",
  database: "orders",
  username: "agent_readonly",
  sslmode: "verify-full",
};

describe("postgres connect form", () => {
  it("keeps four familiar fields visible and secure TLS settings in Advanced", () => {
    if (postgres.connectionMethod.type !== "api_key")
      throw new Error("Expected credentials");
    const { fields } = postgres.connectionMethod;
    expect(
      fields.filter((field) => !field.optional).map((field) => field.label),
    ).toEqual(["Password", "Host", "Database", "Username"]);
    expect(fields.find((field) => field.name === "sslmode")).toMatchObject({
      optional: true,
      defaultValue: "require",
    });
    expect(fields.find((field) => field.name === "sslrootcert")).toMatchObject({
      showWhen: { field: "sslmode", value: "verify-full" },
    });
    expect(fields[0]?.name).toBe("password");
  });
  // The gateway reads the stored credentials by these exact names
  // (`dbproxy::target::DbTarget`); a renamed field would store a connection
  // the gateway cannot dial.
  it("stores the fields under the names the gateway reads", () => {
    const names =
      postgres.connectionMethod.type === "api_key"
        ? postgres.connectionMethod.fields.map((f) => f.name)
        : [];
    expect(names.sort()).toEqual(
      [
        "database",
        "host",
        "password",
        "port",
        "sslmode",
        "sslrootcert",
        "username",
      ].sort(),
    );
  });

  it("names a valid connection by its database, records where it lives, never the password", async () => {
    const metadata = await resolve(valid);
    expect(metadata).toMatchObject({
      name: "orders",
      tags: ["TLS verified"],
    });
    expect(extractDatabaseTarget(metadata)).toMatchObject({
      host: "db.example.com",
      database: "orders",
    });
    expect(JSON.stringify(metadata)).not.toContain("s3cret");
    expect(
      await resolve({ ...valid, sslmode: "require", port: "" }),
    ).toMatchObject({ tags: ["TLS"] });
    // No encryption is an explicit choice, tagged so every card warns.
    expect(await resolve({ ...valid, sslmode: "disable" })).toMatchObject({
      tags: ["No TLS"],
    });
  });

  it("accepts hostnames and IP literals only", async () => {
    for (const host of ["db", "DB.Example.com", "10.0.0.5", "::1", "fe80::1"]) {
      await expect(resolve({ ...valid, host }), host).resolves.toBeTruthy();
    }
    for (const host of [
      "",
      "db.example.com:5432",
      "postgres://db.example.com",
      "user@db.example.com",
      "db..example.com",
      "-db.example.com",
      "db.example.com/x",
      "db example.com",
    ]) {
      await expect(resolve({ ...valid, host }), host).rejects.toThrow(
        /hostname or IP address/,
      );
    }
  });

  it("refuses an out-of-range port, a missing database and plaintext", async () => {
    for (const port of ["0", "65536", "54x", "-1", "5432.5"]) {
      await expect(resolve({ ...valid, port }), port).rejects.toThrow(/Port/);
    }
    await expect(resolve({ ...valid, database: " " })).rejects.toThrow(
      /Database/,
    );
    for (const sslmode of ["prefer", "allow", "", "VERIFY-FULL"]) {
      await expect(resolve({ ...valid, sslmode }), sslmode).rejects.toThrow(
        /TLS/,
      );
    }
  });

  it("takes a CA certificate only in PEM form", async () => {
    const pem =
      "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
    await expect(resolve({ ...valid, sslrootcert: pem })).resolves.toBeTruthy();
    await expect(
      resolve({ ...valid, sslrootcert: "not a certificate" }),
    ).rejects.toThrow(/PEM/);
  });
});

describe("postgres permission catalog", () => {
  // The gateway judges each statement as one of these synthetic requests
  // (`StatementClass::policy_request`); a drifted path or method would leave
  // a rule that never matches.
  it("covers each statement class the gateway judges, and nothing else", () => {
    const tools = postgresPermissions.groups.flatMap((g) =>
      g.tools.map((t) => ({ ...t, category: g.category })),
    );
    const request = (method: string, path: string) =>
      tools
        .filter((t) => t.method === method && pathMatches(path, t.pathPattern))
        .map((t) => `${t.category}:${t.id}`);
    expect(request("GET", "/sql/read")).toEqual(["read:sql_read"]);
    expect(request("POST", "/sql/write")).toEqual(["write:sql_write"]);
    expect(request("POST", "/sql/schema")).toEqual(["write:sql_schema"]);
    expect(request("GET", "/sql/write")).toEqual([]);
  });
});
