import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { generatedClientDir, generatedClientFresh } from "./prisma-client.mjs";

const SCHEMA = 'generator client {\n  provider = "prisma-client-js"\n}\n';

// realpath, because require resolution returns real paths and macOS hides
// tmpdir behind the /var → /private/var symlink.
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "prisma-fresh-")));

/**
 * A fake packages/db: source schema + an installed `@prisma/client` (flat
 * node_modules, the resolution shape of a plain npm install) and, unless
 * `genDir: false`, a generated client beside it whose embedded schema is
 * `copy` (null = no copy written).
 */
const makeDb = ({
  schema = SCHEMA,
  copy = schema,
  genDir = true,
  indexJs = true,
} = {}) => {
  const dbDir = tmp();
  mkdirSync(join(dbDir, "prisma"));
  writeFileSync(join(dbDir, "prisma", "schema.prisma"), schema);
  writeFileSync(join(dbDir, "package.json"), '{ "name": "db" }\n');
  const pkgDir = join(dbDir, "node_modules", "@prisma", "client");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), '{ "name": "@prisma/client" }\n');
  if (genDir) {
    const gen = join(dbDir, "node_modules", ".prisma", "client");
    mkdirSync(gen, { recursive: true });
    if (copy !== null) writeFileSync(join(gen, "schema.prisma"), copy);
    if (indexJs) writeFileSync(join(gen, "index.js"), "module.exports = {};\n");
  }
  return dbDir;
};

// ── the freshness gate ──────────────────────────────────────────────────────

test("a client generated from the schema on disk is fresh", () => {
  assert.equal(generatedClientFresh(makeDb()), true);
});

test("one byte of schema drift reads as stale", () => {
  // The load-bearing case: the client still loads, `migrate deploy` already
  // ran, and only this comparison stands between `pnpm dev` and a 500 loop.
  assert.equal(generatedClientFresh(makeDb({ copy: `${SCHEMA}\n` })), false);
});

test("a never-generated checkout reads as stale", () => {
  assert.equal(generatedClientFresh(makeDb({ genDir: false })), false);
});

test("a generated dir without the schema copy reads as stale", () => {
  assert.equal(generatedClientFresh(makeDb({ copy: null })), false);
});

test("a generated dir without index.js reads as stale", () => {
  assert.equal(generatedClientFresh(makeDb({ indexJs: false })), false);
});

test("a relative dbDir resolves instead of silently reading stale", () => {
  // createRequire rejects relative paths; without resolve() a relative caller
  // would land in the catch and regenerate on every run.
  const dbDir = makeDb();
  assert.equal(generatedClientFresh(relative(process.cwd(), dbDir)), true);
});

test("an uninstalled @prisma/client reads as stale, not a crash", () => {
  const dbDir = tmp();
  mkdirSync(join(dbDir, "prisma"));
  writeFileSync(join(dbDir, "prisma", "schema.prisma"), SCHEMA);
  writeFileSync(join(dbDir, "package.json"), '{ "name": "db" }\n');
  assert.equal(generatedClientDir(dbDir), null);
  assert.equal(generatedClientFresh(dbDir), false);
});

// ── pnpm layout ─────────────────────────────────────────────────────────────

test("resolution follows a pnpm-style symlink to the store's generated client", (t) => {
  // Real layout: packages/db/node_modules/@prisma/client is a symlink into
  // node_modules/.pnpm/..., and the generated client lives BESIDE the store
  // copy — never beside the symlink. The check must land on the store.
  const root = tmp();
  const dbDir = join(root, "packages", "db");
  mkdirSync(join(dbDir, "prisma"), { recursive: true });
  writeFileSync(join(dbDir, "prisma", "schema.prisma"), SCHEMA);
  writeFileSync(join(dbDir, "package.json"), '{ "name": "db" }\n');

  const store = join(root, "node_modules", ".pnpm", "c@0", "node_modules");
  mkdirSync(join(store, "@prisma", "client"), { recursive: true });
  writeFileSync(
    join(store, "@prisma", "client", "package.json"),
    '{ "name": "@prisma/client" }\n',
  );
  const gen = join(store, ".prisma", "client");
  mkdirSync(gen, { recursive: true });
  writeFileSync(join(gen, "schema.prisma"), SCHEMA);
  writeFileSync(join(gen, "index.js"), "module.exports = {};\n");

  mkdirSync(join(dbDir, "node_modules", "@prisma"), { recursive: true });
  try {
    symlinkSync(
      join(store, "@prisma", "client"),
      join(dbDir, "node_modules", "@prisma", "client"),
      "dir",
    );
  } catch {
    return t.skip("platform cannot create symlinks");
  }

  assert.equal(generatedClientDir(dbDir), gen);
  assert.equal(generatedClientFresh(dbDir), true);
});
