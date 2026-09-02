// Freshness of the generated Prisma client — the launcher's answer to "did
// `prisma generate` run against the schema that is on disk right now?".
//
// A loadable client is not a current one: a client generated before a schema
// pull still `require()`s fine and then rejects the new fields at runtime.
// The reliable signal is the byte-verbatim copy of the source schema that
// prisma-client-js writes next to the generated code — equal bytes mean
// current, anything else (never generated, torn, or generated from a schema
// this checkout has since moved past) means regenerate. `prisma generate` is
// idempotent, so every unsure case safely reads as stale.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

/**
 * Where prisma-client-js generated the client for this checkout: the
 * `.prisma/client` directory beside the *resolved* `@prisma/client` package —
 * the same place Prisma's default output points. Resolving through `dbDir`'s
 * own require chain follows the pnpm symlink into the store, so this lands on
 * the real generated files, not the link. Null when `@prisma/client` is not
 * installed at all.
 */
export const generatedClientDir = (dbDir) => {
  try {
    // resolve(), because createRequire rejects relative paths — and this
    // module's whole job is making sure "unsure" never silently wins.
    const req = createRequire(join(resolve(dbDir), "package.json"));
    const pkg = req.resolve("@prisma/client/package.json");
    // <store>/node_modules/@prisma/client/package.json
    //   → <store>/node_modules/.prisma/client
    return join(dirname(pkg), "..", "..", ".prisma", "client");
  } catch {
    return null;
  }
};

/**
 * True only when a generated client exists and embeds a byte-identical copy
 * of `<dbDir>/prisma/schema.prisma`.
 */
export const generatedClientFresh = (dbDir) => {
  const dir = generatedClientDir(dbDir);
  if (!dir || !existsSync(join(dir, "index.js"))) return false;
  try {
    return (
      readFileSync(join(dir, "schema.prisma"), "utf8") ===
      readFileSync(join(dbDir, "prisma", "schema.prisma"), "utf8")
    );
  } catch {
    return false;
  }
};
