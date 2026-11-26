import { describe, expect, it } from "vitest";
import { parseConnectionString } from "./parse-connection-string";

describe("parseConnectionString", () => {
  it("fills every field from a full URL, decoding escapes", () => {
    expect(
      parseConnectionString(
        "postgresql://agent%40ro:p%40ss%2Fw@db.example.com:6543/orders?sslmode=verify-full",
      ),
    ).toEqual({
      fields: {
        host: "db.example.com",
        port: "6543",
        database: "orders",
        username: "agent@ro",
        password: "p@ss/w",
        sslmode: "verify-full",
      },
      plaintextRequested: false,
    });
  });

  it("leaves out what the string does not say", () => {
    expect(parseConnectionString("postgres://db.example.com")?.fields).toEqual({
      host: "db.example.com",
    });
  });

  it("maps sslmode onto the modes OneCLI dials with", () => {
    const mode = (s: string) =>
      parseConnectionString(`postgres://h/d?sslmode=${s}`);
    expect(mode("require")?.fields.sslmode).toBe("require");
    // allow and prefer accept TLS: OneCLI encrypts, never falls back.
    expect(mode("prefer")).toMatchObject({
      fields: { sslmode: "require" },
      plaintextRequested: false,
    });
    expect(mode("allow")).toMatchObject({
      fields: { sslmode: "require" },
      plaintextRequested: false,
    });
    expect(mode("verify-ca")?.fields.sslmode).toBe("verify-full");
    expect(mode("disable")).toMatchObject({
      fields: { sslmode: "disable" },
      plaintextRequested: true,
    });
  });

  it("handles IPv6 hosts", () => {
    expect(
      parseConnectionString("postgres://u@[::1]:5432/d")?.fields.host,
    ).toBe("::1");
  });

  it("rejects anything that is not a postgres URL", () => {
    for (const s of ["", "db.example.com", "mysql://h/d", "host=h dbname=d"])
      expect(parseConnectionString(s), s).toBeNull();
  });
});
