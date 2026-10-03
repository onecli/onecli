import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The OSS sync is deny-list shaped: every file syncs unless CLOUD-DEVELOPMENT.md's
// exclusion table names it, and that table is prose with no other gate. This
// guard makes the boundary mechanical twice over: (1) for whole cloud-only
// PACKAGES — each one listed below must have an exclusion row, so deleting
// the row (or adding a cloud-only package without one) fails `pnpm check` on
// the cloud side before a sync window can ever carry the package upstream;
// and (2) for the PROSE of every synced file — no comment may name the
// cloud's implementation (CLOUD-DEVELOPMENT.md, "Comments in synced files
// never describe the cloud's implementation").

/** Workspace packages that must never reach the OSS mirror. */
const CLOUD_ONLY_PACKAGES = [
  "packages/infra",
  "apps/sandbox-manager",
  "apps/sandbox-home-device",
  "apps/sandbox-home-daemon",
  "apps/sandbox-log-shipper",
  "packages/sandbox-home-device-proto",
  "packages/sandbox-shared",
];

const path = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

// `scripts/` itself syncs to OSS, where the boundary doc and the cloud-only
// directories are absent by design — there this file must be a silent no-op
// (the scripts/dev.mjs existsSync precedent). Repo identity is keyed on the
// root package name, which the sync rewrites field-level — NOT on the
// boundary doc's existence, or renaming the doc would silently disarm the
// guard in the very repo it protects.
const boundaryDoc = path("CLOUD-DEVELOPMENT.md");
const rootPackageName = JSON.parse(
  readFileSync(path("package.json"), "utf8"),
).name;
const inCloudRepo = rootPackageName === "onecli-cloud";

/** The exclusion table's pattern cells: table lines whose first cell is a
 * backticked pattern. */
const exclusionPatterns = () => {
  const doc = readFileSync(boundaryDoc, "utf8");
  return [...doc.matchAll(/^\|\s*`([^`]+)`/gm)].map((m) => m[1]);
};

test(
  "cloud-only packages each have an exclusion row",
  { skip: !inCloudRepo },
  () => {
    assert.ok(
      existsSync(boundaryDoc),
      "CLOUD-DEVELOPMENT.md is missing from the cloud repo — the exclusion list (and this guard's subject) is gone",
    );
    const patternCells = exclusionPatterns();

    // Positive controls: a reformatted table must fail here, not pass vacuously.
    assert.ok(
      patternCells.length >= 8,
      `expected the exclusion table's pattern cells, found ${patternCells.length}`,
    );
    assert.ok(
      !patternCells.some((cell) => cell.startsWith("apps/web/**")),
      "apps/web is shared — a row excluding it means the parse grabbed the wrong table",
    );

    for (const pkg of CLOUD_ONLY_PACKAGES) {
      assert.ok(
        existsSync(path(pkg)),
        `${pkg} is in CLOUD_ONLY_PACKAGES but does not exist — remove it here`,
      );
      assert.ok(
        patternCells.some((cell) => cell === `${pkg}/**`),
        `${pkg} exists but CLOUD-DEVELOPMENT.md's exclusion table has no \`${pkg}/**\` row — ` +
          "without it, /sync-oss would copy the whole package to the public mirror.",
      );
    }
  },
);

// ── Comments in synced files ────────────────────────────────────────────────

/**
 * Terms that only ever describe OUR cloud's implementation — never product
 * behavior a self-hoster could see. Deliberately narrow (a backstop, not the
 * rule): generic words like "pod", "S3" or "load balancer" are legitimate in
 * shared prose and are left to review. Every entry was checked against the
 * whole synced tree for false positives when it was added.
 */
const CLOUD_IMPLEMENTATION_TERMS = [
  /\bkata\b/i,
  /\bmicro-?vms?\b/i,
  /\bublk\b/i,
  /\bkubelet\b/i,
  /\bkarpenter\b/i,
  /\btopolvm\b/i,
  /\b(eks|irsa|fargate|ecs)\b/i,
  /\bcloudfront\b/i,
  /\belasticache\b/i,
  /\bcloudwatch\b/i,
  /\b(nlb|alb)\b/i,
  /\bpvcs?\b/i,
  /\bresourcequota\b/i,
  /\bserviceaccount\b/i,
  /\bkube-root-ca\b/i,
  /\btwingate\b/i,
  /\bsandbox[- ]manager\b/i,
  /\bhome[- ](daemon|device)\b/i,
  /\blog[- ]shipper\b/i,
  /\bsandbox-shared\b/i,
  /\bsandbox[- ]platform\b/i,
  /\bpackages\/infra\b/,
  /\b[a-z-]+-stack\.ts\b/,
  /\bapi-server-stack\b/,
  /\bmetric filters?\b/i,
  /\btask (role|definition)s?\b/i,
  /\brwo\b/i,
  /\b[a-z0-9]+-dev\.onecli\.sh\b/i,
  /\bcloud-scripts\b/,
  /\bplans\/deploy-ownership\b/,
  /\bdeploy(-infra|-sandbox-platform|-analytics)?\.yml\b/,
  /\bdev live gate\b/i,
  /\bobserved on dev\b/i,
];

/** Synced files whose prose may name these terms by design. */
const COMMENT_SCAN_EXEMPT = [
  // This guard and the legacy ledger name the cloud-only paths they police.
  "scripts/cloud-boundary.test.mjs",
  "scripts/legacy-marker.test.mjs",
  // Ignore files list cloud-only build outputs so a local cloud checkout
  // stays clean; they are paths, not prose.
  ".gitignore",
  ".dockerignore",
  ".prettierignore",
];

/** Applied migrations are checksum-locked: never edited, so never scanned. */
const isAppliedMigration = (file) =>
  /^packages\/db\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(file);

/** A glob from the exclusion table, as a matcher over repo-relative paths. */
const globToRegExp = (glob) => {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      re += ".*";
      i += 1;
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "{") {
      const end = glob.indexOf("}", i);
      re += `(${glob
        .slice(i + 1, end)
        .split(",")
        .map((s) => s.replace(/[.+?^$()[\]\\|]/g, "\\$&"))
        .join("|")})`;
      i = end;
    } else re += ch.replace(/[.+?^$()[\]\\|]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
};

/** Every tracked file the OSS mirror receives: tracked minus every glob the
 * exclusion table names (a row's first cell may list several, e.g.
 * `CLAUDE.md`, `.claude/**`; the workflow carve-out pair stays synced). */
const syncedFiles = () => {
  const doc = readFileSync(boundaryDoc, "utf8");
  const firstCells = [...doc.matchAll(/^\|([^|]*`[^|]*)\|/gm)]
    .map((m) => m[1])
    // The root `package.json` row is field-level: the file itself syncs.
    .filter((cell) => !cell.trim().startsWith("root "));
  const globs = firstCells.flatMap((cell) =>
    [...cell.matchAll(/`([^`\s]+)`/g)]
      .map((m) => m[1])
      // Only path globs: skip prose tokens like `name` or `generate:catalog`.
      .filter((g) => /[/*.]/.test(g) && !g.includes(":")),
  );
  // `apps/{web,…}/Dockerfile.cloud` and `apps/*/cloud-*.{sh,mjs}` are the
  // brace-expanded deploy-artifact rows.
  const excluded = globs.map(globToRegExp);
  const carveOut = new Set([
    ".github/workflows/publish.yml",
    ".github/workflows/release.yml",
  ]);
  return execFileSync("git", ["ls-files"], { cwd: path("."), encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((f) => carveOut.has(f) || !excluded.some((re) => re.test(f)));
};

const TS_LIKE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const HASH_LIKE =
  /(^|\/)(Dockerfile[^/]*|[^/]*\.Dockerfile|[^/]*\.(sh|ya?ml|toml)|\.env\.example|onecli-nix-install)$/;

/** The prose of a file, as `{ line, text }` rows: comments for code (TS/JS
 * via the real TypeScript parser, so strings and templates are never
 * mistaken for comments), the whole text for Markdown. */
const commentsOf = async (file, source) => {
  const rows = [];
  if (TS_LIKE.test(file)) {
    const { default: ts } = await import("typescript");
    const kind = /x$/.test(file)
      ? ts.ScriptKind.TSX
      : /\.(js|mjs|cjs)$/.test(file)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      kind,
    );
    const seen = new Map();
    const take = (ranges) => {
      for (const r of ranges ?? []) seen.set(r.pos, source.slice(r.pos, r.end));
    };
    const visit = (node) => {
      take(ts.getLeadingCommentRanges(source, node.getFullStart()));
      take(ts.getTrailingCommentRanges(source, node.getEnd()));
      for (const child of node.getChildren(sf)) visit(child);
    };
    visit(sf);
    for (const [pos, text] of seen) {
      const start = source.slice(0, pos).split("\n").length;
      text
        .split("\n")
        .forEach((t, i) => rows.push({ line: start + i, text: t }));
    }
    return rows;
  }
  const lines = source.split("\n");
  const marker = /\.rs$/.test(file)
    ? "//"
    : /\.(sql|prisma)$/.test(file)
      ? /(--|\/\/)/
      : HASH_LIKE.test(file)
        ? "#"
        : null;
  lines.forEach((text, i) => {
    if (/\.md$/.test(file)) rows.push({ line: i + 1, text });
    else if (typeof marker === "string" && text.includes(marker)) {
      rows.push({ line: i + 1, text: text.slice(text.indexOf(marker)) });
    } else if (marker instanceof RegExp) {
      const m = text.match(marker);
      if (m) rows.push({ line: i + 1, text: text.slice(m.index) });
    }
  });
  return rows;
};

test(
  "no synced file's comments name the cloud's implementation",
  { skip: !inCloudRepo },
  async () => {
    const files = syncedFiles();
    // Positive control: the synced set is the shared product, not an empty
    // or mis-parsed list — and it never contains an excluded package.
    assert.ok(
      files.length > 1000,
      `expected the synced tree, got ${files.length} files`,
    );
    assert.ok(files.includes("apps/web/package.json"));
    assert.ok(!files.some((f) => f.startsWith("packages/infra/")));

    const findings = [];
    for (const file of files) {
      if (COMMENT_SCAN_EXEMPT.includes(file) || isAppliedMigration(file))
        continue;
      let source;
      try {
        source = readFileSync(path(file), "utf8");
      } catch {
        continue;
      }
      for (const { line, text } of await commentsOf(file, source)) {
        const hit = CLOUD_IMPLEMENTATION_TERMS.find((re) => re.test(text));
        if (hit)
          findings.push(
            `${file}:${line} ${hit} — ${text.trim().slice(0, 120)}`,
          );
      }
    }
    assert.deepEqual(
      findings,
      [],
      "synced comments describe the cloud's implementation — rewrite them in the generic form " +
        '(CLOUD-DEVELOPMENT.md, "Comments in synced files never describe the cloud\'s implementation"):\n' +
        findings.join("\n"),
    );
  },
);

test(
  "the comment guard catches what it claims to (negative control)",
  { skip: !inCloudRepo },
  async () => {
    // Proves the extractor reads real comments and ignores code: a term in a
    // comment is found, the same term inside a string literal is not.
    const rows = await commentsOf(
      "x.ts",
      'const a = "kata";\n// boots under Kata on EKS\nconst b = `sandbox-manager ${a}`;\n',
    );
    const flagged = rows.filter(({ text }) =>
      CLOUD_IMPLEMENTATION_TERMS.some((re) => re.test(text)),
    );
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].line, 2);
  },
);
