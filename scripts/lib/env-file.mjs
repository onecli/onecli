// A line-preserving .env editor: parse, read, upsert, atomic save.
//
// This is the one place that understands env files, shared by `pnpm dev`
// (scripts/dev.mjs, maintaining the repo-root .env) and `pnpm run setup`
// (scripts/setup/, maintaining docker/.env). Both tools write INTO a file the
// developer also edits by hand, so the contract is strict:
//
//   - an untouched file round-trips byte-identically,
//   - a valid existing value is never overwritten,
//   - edits replace in place (keeping `export ` prefixes, quote style and
//     inline comments), uncomment `# KEY=` stubs before appending, and only
//     append under a clearly-labelled generated block,
//   - reads follow dotenv semantics: last assignment wins inside the file,
//     and the process environment always beats the file,
//   - the files this engine manages hold secrets, so save() always asserts
//     mode 0600 — a hand-created 0644 file gets tightened, not preserved.

import {
  chmodSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const ASSIGN_RE = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
const QUOTES = new Set(['"', "'", "`"]);

/** Index of the first unescaped `quote` in `text`, or -1. */
const findClose = (text, quote, from = 0) => {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\" && quote === '"') {
      i++;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return -1;
};

/** Parse the part after `=`. Returns {quote, value, tail, open}. */
const parseValue = (rest) => {
  const first = rest[0];
  if (QUOTES.has(first)) {
    const close = findClose(rest, first, 1);
    if (close !== -1)
      return {
        quote: first,
        value: rest.slice(1, close),
        tail: rest.slice(close + 1),
        open: false,
      };
    // No closing quote on this line — a multi-line quoted value (maybe).
    return { quote: first, value: rest.slice(1), tail: "", open: true };
  }
  // Unquoted: an inline comment starts at whitespace + '#'. A bare '#' glued
  // to the value (postgresql://…#frag) stays part of the value.
  const m = rest.match(/^(.*?)(\s+#.*)?$/);
  return {
    quote: null,
    value: (m?.[1] ?? rest).trimEnd(),
    tail: m?.[2] ?? "",
    open: false,
  };
};

/**
 * One logical line. `raw` is authoritative until `modified` is set; a
 * modified entry's `value` is PLAINTEXT and is escaped at render time.
 */
const assignment = (raw, leading, exportPrefix, key, quote, value, tail) => ({
  kind: "assignment",
  raw,
  leading,
  exportPrefix: exportPrefix ?? "",
  key,
  quote,
  value,
  tail,
  modified: false,
});

const rawLine = (kind, text) => ({ kind, raw: text });

const classify = (text) => {
  const trimmed = text.trim();
  if (trimmed === "") return rawLine("blank", text);
  if (trimmed.startsWith("#")) return rawLine("comment", text);
  const m = text.match(ASSIGN_RE);
  if (!m) return rawLine("opaque", text);
  const { quote, value, tail, open } = parseValue(m[4]);
  return { entry: assignment(text, m[1], m[2], m[3], quote, value, tail), open };
};

/** Escape a plaintext value for a double-quoted rendering. */
const escapeDouble = (value) =>
  value
    .replace(/[\\"]/g, (c) => `\\${c}`)
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");

const renderValue = (quote, value) => {
  if (quote === '"') return `"${escapeDouble(value)}"`;
  if (quote) return `${quote}${value}${quote}`;
  return value;
};

const render = (e) => {
  if (e.kind !== "assignment" || !e.modified) return e.raw;
  return `${e.leading}${e.exportPrefix}${e.key}=${renderValue(e.quote, e.value)}${e.tail}`;
};

/** The plaintext a consumer reads. Double quotes cook escapes (dotenv rule). */
const cook = (e) => {
  if (e.modified) return e.value; // already plaintext
  if (e.quote !== '"') return e.value;
  return e.value.replace(/\\([\\"nr])/g, (_, ch) =>
    ch === "n" ? "\n" : ch === "r" ? "\r" : ch,
  );
};

/** Pick a quote a plaintext value can actually live in. */
const quoteFor = (current, value) => {
  if (value.includes("\n") || value.includes("\r")) return '"';
  if (current === "'" && value.includes("'")) return '"';
  if (current === "`" && value.includes("`")) return '"';
  if (current === null && /[\s#'"`]/.test(value)) return '"';
  return current;
};

export class EnvFile {
  /** @param {string} path @param {{label?: string}} [opts] label names the tool in the generated-block header. */
  constructor(path, { label = "pnpm dev" } = {}) {
    this.path = path;
    this.label = label;
    this.entries = [];
    this.eol = "\n";
    this.finalNewline = true;
    this.existed = false;
    this.dirty = false;
    this.headerIndex = -1;

    let content = null;
    try {
      content = readFileSync(path, "utf8");
      this.existed = true;
    } catch (err) {
      // Only a genuinely missing file means "start empty". An unreadable one
      // (EACCES, EISDIR, …) must never be silently replaced — it may hold the
      // instance's encryption key.
      if (err?.code !== "ENOENT") throw err;
      return;
    }

    this.eol = content.includes("\r\n") ? "\r\n" : "\n";
    this.finalNewline = content === "" || content.endsWith("\n");
    const lines = content.split(/\r?\n/);
    if (this.finalNewline && lines.length && lines[lines.length - 1] === "")
      lines.pop();

    for (let i = 0; i < lines.length; i++) {
      const c = classify(lines[i]);
      if (!c.entry) {
        this.entries.push(c);
        continue;
      }
      if (c.open) {
        // Multi-line quoted value: consume until the first unescaped closing
        // quote (anywhere in a line — `def" # comment` closes at the quote).
        const parts = [lines[i]];
        const inner = [c.entry.value];
        let closedAt = -1;
        let tail = "";
        let j = i;
        while (++j < lines.length) {
          const idx = findClose(lines[j], c.entry.quote);
          parts.push(lines[j]);
          if (idx !== -1) {
            inner.push(lines[j].slice(0, idx));
            tail = lines[j].slice(idx + 1);
            closedAt = j;
            break;
          }
          inner.push(lines[j]);
        }
        if (closedAt !== -1) {
          c.entry.raw = parts.join(this.eol);
          c.entry.value = inner.join("\n");
          c.entry.tail = tail;
          this.entries.push(c.entry);
          i = closedAt;
        } else {
          // Unterminated quote: dotenv treats the line as a bare value (the
          // quote char included) and every following line parses normally —
          // NOT as part of a value. Anything else lets one hand-edit typo
          // swallow the rest of the file, hide real keys, and trick a caller
          // into re-minting secrets that already exist.
          c.entry.quote = null;
          c.entry.value = `${lines[i].match(ASSIGN_RE)[4]}`;
          c.entry.tail = "";
          this.entries.push(c.entry);
        }
      } else this.entries.push(c.entry);
    }
  }

  #last(key) {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.kind === "assignment" && e.key === key) return e;
    }
    return null;
  }

  /** Keys assigned more than once — last one wins; callers may warn. */
  duplicates() {
    const seen = new Map();
    for (const e of this.entries)
      if (e.kind === "assignment")
        seen.set(e.key, (seen.get(e.key) ?? 0) + 1);
    return [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  }

  has(key) {
    return this.#last(key) !== null;
  }

  /** Cooked value of the last assignment, or undefined when absent. */
  get(key) {
    const e = this.#last(key);
    return e ? cook(e) : undefined;
  }

  /**
   * Set `key` to `value` (plaintext): replace the last assignment in place,
   * else uncomment the last `# KEY=` stub, else append under the generated
   * block (with `comment` lines above it). Never call this to overwrite a
   * value the user should keep — that judgement lives with the caller.
   */
  upsert(key, value, { comment } = {}) {
    const existing = this.#last(key);
    if (existing) {
      if (cook(existing) === value) return false;
      existing.quote = quoteFor(existing.quote, value);
      existing.value = value;
      existing.modified = true;
      this.dirty = true;
      return true;
    }

    const stubRe = new RegExp(`^(\\s*)#\\s*(export\\s+)?${key}\\s*=`);
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.kind !== "comment") continue;
      const m = e.raw.match(stubRe);
      if (!m) continue;
      const next = assignment("", m[1], m[2], key, quoteFor(null, value), value, "");
      next.modified = true;
      this.entries[i] = next;
      this.dirty = true;
      return true;
    }

    if (this.headerIndex === -1) {
      const header = `# ── Generated by \`${this.label}\` — yours to edit; values here are never overwritten ──`;
      const idx = this.entries.findIndex(
        (e) => e.kind === "comment" && e.raw === header,
      );
      if (idx !== -1) this.headerIndex = idx;
      else {
        if (
          this.entries.length &&
          this.entries[this.entries.length - 1].kind !== "blank"
        )
          this.entries.push(rawLine("blank", ""));
        this.entries.push(rawLine("comment", header));
        this.headerIndex = this.entries.length - 1;
      }
    }
    for (const line of comment ? comment.split("\n") : [])
      this.entries.push(rawLine("comment", `# ${line}`));
    const added = assignment("", "", "", key, quoteFor(null, value), value, "");
    added.modified = true;
    this.entries.push(added);
    this.dirty = true;
    return true;
  }

  /**
   * Append a commented `# KEY=value` stub (with `comment` lines above it) so
   * the file documents an optional knob without pinning a value. A later
   * `upsert` un-comments the stub in place. No-op when the key already
   * exists as an assignment or as a stub.
   */
  hintStub(key, value, { comment } = {}) {
    if (this.#last(key)) return false;
    const stubRe = new RegExp(`^(\\s*)#\\s*(export\\s+)?${key}\\s*=`);
    for (const e of this.entries)
      if (e.kind === "comment" && stubRe.test(e.raw)) return false;
    if (
      this.entries.length &&
      this.entries[this.entries.length - 1].kind !== "blank"
    )
      this.entries.push(rawLine("blank", ""));
    for (const line of comment ? comment.split("\n") : [])
      this.entries.push(rawLine("comment", `# ${line}`));
    this.entries.push(rawLine("comment", `# ${key}=${value}`));
    this.dirty = true;
    return true;
  }

  /**
   * Atomic write: tmp file in the same directory, then rename — and the
   * result is always 0600, because every file this engine manages holds
   * secrets. No-op when nothing changed.
   */
  save() {
    if (!this.dirty && this.existed) return false;
    const body = this.entries.map(render).join(this.eol);
    const content = body + (this.finalNewline || body === "" ? this.eol : "");
    const tmp = join(
      dirname(this.path),
      `.${basename(this.path)}.${process.pid}.tmp`,
    );
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
    this.existed = true;
    this.dirty = false;
    return true;
  }
}

/**
 * dotenv-expand-compatible expansion: ${VAR}, ${VAR:-def}, ${VAR-def}, $VAR,
 * with \$ as the escape. Single-quoted values are never expanded (dotenv
 * rule) — the caller enforces that by not calling this for them. Nested
 * defaults (`${A:-${B}}`) are NOT supported, same as dotenv-expand's own
 * regex; keep defaults literal.
 */
export const expand = (raw, lookup) =>
  raw.replace(
    /\\\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced, dashOp, def, bare) => {
      if (match === "\\$") return "$";
      const name = braced ?? bare;
      const value = lookup(name);
      if (dashOp === ":-") return value ? value : (def ?? "");
      if (dashOp === "-") return value !== undefined ? value : (def ?? "");
      return value ?? "";
    },
  );

/**
 * The merged environment a process should see: file values (expanded, last
 * assignment wins) overlaid by the real process env — the shell ALWAYS wins
 * over the file, exactly like dotenv-cli's no-override rule. A forward
 * reference (`B=${A}` before `A=` is defined) resolves to "" — references
 * see only what is already defined above them, shell included.
 */
export const resolveEnv = (envFile, processEnv = process.env) => {
  const fromFile = {};
  for (const e of envFile.entries) {
    if (e.kind !== "assignment") continue;
    const cooked = cook(e);
    fromFile[e.key] =
      e.quote === "'"
        ? cooked
        : expand(cooked, (name) =>
            name in processEnv ? processEnv[name] : fromFile[name],
          );
  }
  return { ...fromFile, ...processEnv };
};
