import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Em dashes read as AI-generated writing, so user-facing copy bans them
 * (product decision; see the copy style rules in the PR that added this).
 * Every string literal, template literal, and JSX text node in this app is
 * user-facing copy, so this guard scans them all. Comments keep their em
 * dashes (they are not copy), which is why this walks the AST instead of
 * grepping lines. `logger.*` / `console.*` arguments are exempt: log lines
 * are operator output, not product copy.
 *
 * packages/api deliberately has no such guard — its tree mixes user-facing
 * copy with model-facing prompt text line by line, and prompt text may use
 * em dashes; a scanner cannot tell the audiences apart.
 */

const EM_DASH = "—";
const SRC_ROOT = path.resolve(import.meta.dirname, "..");

const LITERAL_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.JsxText,
]);

const HARNESS_DIR = path.join(SRC_ROOT, "test");

const collectSourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // src/test is the vitest harness, not product code. Only that exact
      // directory is exempt; a nested product dir named test/ stays guarded.
      if (full === HARNESS_DIR) return [];
      return collectSourceFiles(full);
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) return [];
    if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) return [];
    if (entry.name.endsWith(".d.ts")) return [];
    return [full];
  });

const insideLogCall = (node: ts.Node): boolean => {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isCallExpression(cur)) {
      const callee = cur.expression.getText();
      if (/^(logger|console)\b/.test(callee)) return true;
    }
  }
  return false;
};

const emDashViolations = (filePath: string): string[] => {
  const content = readFileSync(filePath, "utf8");
  if (!content.includes(EM_DASH)) return [];
  const source = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations: string[] = [];
  // JsxText keeps HTML entities undecoded, so an entity-written em dash
  // would slip past the literal check without this.
  const EM_DASH_ENTITY = /&(?:mdash|#8212|#x2014);/i;
  const visit = (node: ts.Node): void => {
    if (LITERAL_KINDS.has(node.kind)) {
      const text = (node as ts.LiteralLikeNode).text;
      const hit = text.includes(EM_DASH) || EM_DASH_ENTITY.test(text);
      if (hit && !insideLogCall(node)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        violations.push(
          `${path.relative(SRC_ROOT, filePath)}:${line + 1} ${text.trim().slice(0, 80)}`,
        );
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  return violations;
};

describe("ui copy", () => {
  it("holds zero em dashes in user-facing strings", () => {
    const violations = collectSourceFiles(SRC_ROOT).flatMap(emDashViolations);
    expect(
      violations,
      `Em dashes found in UI strings. Reword with a comma, colon, period, or parentheses:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
