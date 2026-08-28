import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Em dashes read as AI-generated writing, so the copy this adapter posts
 * into Slack bans them (product decision; mirrors the guard in apps/web).
 * The AST walk keeps code comments exempt (they are not copy), and
 * `logger.*` / `console.*` arguments are operator output, not product copy.
 */

const EM_DASH = "—";
const SRC_ROOT = import.meta.dirname;

const LITERAL_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

const collectSourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // src/test holds the fakes harness, not product code.
      if (entry.name === "test") return [];
      return collectSourceFiles(full);
    }
    if (!entry.name.endsWith(".ts")) return [];
    if (/\.(test|spec)\.ts$/.test(entry.name)) return [];
    return [full];
  });

const insideLogCall = (node: ts.Node): boolean => {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isCallExpression(cur)) {
      const callee = cur.expression.getText();
      // Covers logger.*/console.*/log(...) and the adapter's injected
      // logging seam (deps.onLog(...)).
      if (/(^|\.)(logger|console|log|onLog)\b/.test(callee)) return true;
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
    ts.ScriptKind.TS,
  );
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (LITERAL_KINDS.has(node.kind)) {
      const text = (node as ts.LiteralLikeNode).text;
      if (text.includes(EM_DASH) && !insideLogCall(node)) {
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

describe("slack copy", () => {
  it("holds zero em dashes in user-facing strings", () => {
    const violations = collectSourceFiles(SRC_ROOT).flatMap(emDashViolations);
    expect(
      violations,
      `Em dashes found in Slack-facing strings. Reword with a comma, colon, period, or parentheses:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
