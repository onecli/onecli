import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentConnectionWire } from "@onecli/agent-protocol";
import { describe, expect, it } from "vitest";

import { createPgFilesWriter, pgFiles, pgServices } from "./databases";

const database = (
  connectionId: string,
  label: string | null,
): AgentConnectionWire => ({
  provider: "postgres",
  name: "PostgreSQL",
  label,
  host: null,
  database: { engine: "postgres", connectionId },
});

const gateway = { host: "gateway.internal", port: 10255, token: "aoc_tok" };

describe("pgServices", () => {
  it("names each database by its label, made libpq-safe, else by its id", () => {
    const services = pgServices([
      database("c1", "Orders DB (prod)"),
      database("c2", null),
      { provider: "github", name: "GitHub", label: "me", host: null },
      database("c3", "orders-db-prod"),
      database("c4", "!!!"),
    ]);
    expect(services.map((s) => [s.name, s.connectionId])).toEqual([
      ["orders-db-prod", "c1"],
      ["c2", "c2"],
      // A label colliding with an earlier service falls back to its id.
      ["c3", "c3"],
      ["c4", "c4"],
    ]);
  });
});

describe("pgFiles", () => {
  it("points every service at the gateway with the connection as the user", () => {
    const files = pgFiles(pgServices([database("c1", "orders")]), gateway);
    expect(files.serviceFile).toBe(
      [
        "[orders]",
        "host=gateway.internal",
        "port=10255",
        "user=c1",
        "dbname=c1",
        "sslmode=verify-ca",
        "",
      ].join("\n"),
    );
    expect(files.passFile).toBe("gateway.internal:10255:*:c1:aoc_tok\n");
  });

  it("escapes the pgpass delimiters in every field", () => {
    const files = pgFiles(pgServices([database("c1", null)]), {
      host: "::1",
      port: 10255,
      token: "a:b\\c",
    });
    expect(files.passFile).toBe("\\:\\:1:10255:*:c1:a\\:b\\\\c\n");
  });

  it("is empty when no database is attached", () => {
    expect(pgFiles([], gateway)).toEqual({ serviceFile: "", passFile: "" });
  });
});

describe("createPgFilesWriter", () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "pgfiles-"));
    const paths = {
      service: join(dir, "pg_service.conf"),
      pass: join(dir, "pgpass"),
    };
    return { dir, paths, write: createPgFilesWriter(gateway, paths) };
  };

  it("writes the token owner-only and clears both files when nothing is attached", () => {
    const { paths, write } = setup();
    write([database("c1", "orders")]);
    expect(readFileSync(paths.service, "utf8")).toContain("[orders]");
    expect(readFileSync(paths.pass, "utf8")).toContain("aoc_tok");
    expect(lstatSync(paths.pass).mode & 0o777).toBe(0o600);
    write([]);
    expect(existsSync(paths.service)).toBe(false);
    expect(existsSync(paths.pass)).toBe(false);
  });

  it("replaces a planted symlink instead of writing the token through it", () => {
    const { dir, paths, write } = setup();
    const victim = join(dir, "victim");
    symlinkSync(victim, paths.pass);
    write([database("c1", null)]);
    expect(lstatSync(paths.pass).isSymbolicLink()).toBe(false);
    expect(readFileSync(paths.pass, "utf8")).toContain("aoc_tok");
    expect(existsSync(victim)).toBe(false);
  });

  it("does nothing without a gateway to point at", () => {
    const dir = mkdtempSync(join(tmpdir(), "pgfiles-"));
    const paths = { service: join(dir, "s"), pass: join(dir, "p") };
    createPgFilesWriter(undefined, paths)([database("c1", null)]);
    expect(existsSync(paths.service)).toBe(false);
  });
});
