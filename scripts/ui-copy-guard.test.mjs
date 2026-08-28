import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

/**
 * Em dashes read as AI-generated writing, so operator-facing setup output
 * bans them (product decision; mirrors the AST guards in apps/web and
 * apps/channel-adapter). These files have no TypeScript toolchain in this
 * suite, so the scan is line-based with comment stripping: comments keep
 * their em dashes (they are not copy). scripts/dev.mjs and scripts/lib are
 * developer tooling, deliberately unguarded.
 */

const EM_DASH = "—";
const ROOT = path.resolve(import.meta.dirname, "..");

const setupDir = path.join(ROOT, "scripts", "setup");
const mjsFiles = readdirSync(setupDir)
  .filter((name) => name.endsWith(".mjs"))
  .map((name) => path.join(setupDir, name));

/** Strips // and block comments per line; good enough for our own scripts. */
const strippedCodeLines = (content) => {
  const lines = [];
  let inBlock = false;
  for (let [i, raw] of content.split("\n").entries()) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlock = false;
    }
    line = line.replace(/\/\*.*?\*\//g, "");
    const blockStart = line.indexOf("/*");
    if (blockStart !== -1) {
      line = line.slice(0, blockStart);
      inBlock = true;
    }
    if (/^\s*\/\//.test(line)) continue;
    // Trailing line comment; the space guard keeps `https://` URLs intact.
    line = line.replace(/ \/\/ .*$/, "");
    lines.push([i + 1, line]);
  }
  return lines;
};

test("setup wizard output holds zero em dashes", () => {
  const violations = [];
  for (const file of mjsFiles) {
    const codeLines = strippedCodeLines(readFileSync(file, "utf8"));
    // Canary: the stripper is string-blind, so a `/*` inside a string
    // literal could swallow the rest of a file unnoticed. Every wizard
    // module has far more code than comments; a near-empty result means
    // the stripper broke, not that the file emptied.
    assert.ok(
      codeLines.length > 10,
      `${path.relative(ROOT, file)}: comment stripping left ${codeLines.length} code lines - the scanner is likely broken`,
    );
    for (const [lineNo, line] of codeLines) {
      if (line.includes(EM_DASH)) {
        violations.push(
          `${path.relative(ROOT, file)}:${lineNo} ${line.trim().slice(0, 80)}`,
        );
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Em dashes found in wizard output. Reword with a comma, colon, period, or parentheses:\n${violations.join("\n")}`,
  );
});

test("install.sh output holds zero em dashes", () => {
  const violations = [];
  const file = path.join(ROOT, "scripts", "install.sh");
  for (const [i, raw] of readFileSync(file, "utf8").split("\n").entries()) {
    if (/^\s*#/.test(raw)) continue;
    // Inline comments (` # …`, incl. after a `:` no-op) are not output.
    const line = raw.replace(/ #.*$/, "");
    if (line.includes(EM_DASH)) {
      violations.push(
        `scripts/install.sh:${i + 1} ${line.trim().slice(0, 80)}`,
      );
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Em dashes found in installer output. Reword with a comma, colon, period, or parentheses:\n${violations.join("\n")}`,
  );
});
