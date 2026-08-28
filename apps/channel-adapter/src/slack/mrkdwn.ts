/* eslint-disable no-control-regex -- U+0000 / U+0001 are this module's
 * stash placeholders and bold sentinels; the regexes must name them. */
import { escapeSlackText } from "@onecli/agent-protocol";

/**
 * Markdown → Slack `mrkdwn` for MODEL-AUTHORED answers.
 *
 * The agent writes GitHub-flavored markdown (the web transcript renders it);
 * Slack speaks its own dialect where `**bold**` shows literal asterisks and
 * headings do not exist. This converts the constructs that actually appear
 * in answers — bold, italics, headings, links, images, lists, blockquotes,
 * strikethrough — and leaves code untouched: fenced blocks and inline spans
 * are lifted out before any rewriting and restored verbatim after, because
 * "markdown" inside code is content, not formatting. Converted links and
 * bare URLs are lifted the same way, so no later pass can rewrite a
 * character inside a URL (Slack: "URLs with spaces will break").
 *
 * SAFETY ORDER: `escapeSlackText` runs FIRST, on the raw text — `<`, `>`,
 * `&` are Slack's only live syntax and a prompt-injected `<!channel>` must
 * die before any rewriting. The only raw angle brackets ever emitted are the
 * converter's own `<url|label>` / `<url>` links, built from `https?://` URLs
 * it validated itself (deliberately NARROWER than the web renderer's
 * allowlist, which also admits mailto/irc/ircs/xmpp and relative URLs —
 * those collapse to plain text here), plus the line-start `>` blockquote
 * marker, which formats but cannot mention or ping. Every emitted `<` is
 * immediately followed by `h` of `https?://`, and Slack directives all need
 * `!`, `@` or `#` there — forgery is structurally impossible. Callers
 * therefore use this INSTEAD of escapeSlackText, never both.
 *
 * BOUNDED WORK: the input is one untrusted model answer and this runs on
 * the adapter's shared event loop, so the converter must stay linear-ish.
 * Line terminators are normalized to `\n` up front (JS multiline anchors
 * also fire at lone `\r` and U+2028/U+2029, which would arm the quote
 * marker mid-line), input is capped at Slack's own 40,000-char message
 * limit (longer can never post — Slack answers msg_too_long), fences are
 * paired by a single line-walk (a lazy fence regex rescans the remainder
 * once per opener: quadratic on a backtick flood), and every other pass is
 * a first-char-disjoint or single-class regex. A committed timing test
 * pins the budget on the known hostile shapes.
 *
 * The stash placeholders use U+0000 and the bold sentinels U+0001; both are
 * STRIPPED from the input on entry, which is what makes them
 * collision-proof (a forged pair could otherwise replay stashed code or
 * fabricate bold — a formatting nuisance, not an escape, but why allow it).
 * A final sweep removes any converter-internal residue, so no control
 * character can reach Slack.
 *
 * Single consumer BY DESIGN: answers reach Slack only through the adapter's
 * mirror pass (the de-streaming decision), so this lives beside the
 * adapter's Slack client. If a second runtime ever needs it, MOVE it to the
 * shared package (`@onecli/agent-protocol`, beside `escapeSlackText`) —
 * never copy it.
 *
 * Accepted gaps — these degrade to readable text on purpose: ordered lists
 * pass through as written (Slack has no list syntax at all; even `•` is
 * convention), emphasis spanning a newline stays literal (Slack
 * styling does not cross lines either way), 4-space indented code is not
 * lifted (agents emit fences), setext `---` underlines vanish via the hr
 * pass while `===` underlines stay literal, bullets/headings inside a
 * blockquote keep their markers, backslash-escaped markdown keeps the
 * backslash, a fence nested inside a longer (4+ tick) fence re-pairs in
 * Slack's flat ``` dialect, and a lone trailing fence line stays prose. An
 * unclosed fence with content below it runs to the end of the message (the
 * GFM rule).
 */

/** Slack's hard message-length cap — text past it can never post. */
const MAX_INPUT_CHARS = 40_000;

/**
 * `https?://` URL admitting one level of balanced parens (Wikipedia-style)
 * and refusing whitespace, `|` (Slack's `<url|label>` separator) and the
 * stash placeholder. The alternatives are first-char disjoint, so matching
 * is linear — no catastrophic backtracking shape. MUST stay
 * capture-group-free: IMAGE_RE/LINK_RE bind their replacer params to $1/$2
 * positionally.
 */
const URL_SOURCE = /https?:\/\/(?:[^\s()|\u0000]|\([^\s()|\u0000]*\))+/.source;

/** Optional markdown link/image title — `"Title"` before the `)` — dropped.
 * MUST stay capture-group-free (see URL_SOURCE). */
const TITLE_SOURCE = /(?:[ \t]+"[^"\n]*")?/.source;

const IMAGE_RE = new RegExp(
  `!\\[([^\\]\\n]*)\\]\\((${URL_SOURCE})${TITLE_SOURCE}\\)`,
  "g",
);
const LINK_RE = new RegExp(
  `\\[([^\\]\\n]+)\\]\\((${URL_SOURCE})${TITLE_SOURCE}\\)`,
  "g",
);
/** Escaped markdown autolink `<https://…>`; lazy, so it stops at the first
 * `&gt;` — the class admits `&`, so an `&amp;`-escaped query survives, and
 * the run is bounded so a giant unterminated token cannot go quadratic. */
const AUTOLINK_RE = /&lt;(https?:\/\/[^\s|\u0000]{1,2048}?)&gt;/g;
const BARE_URL_RE = /https?:\/\/[^\s\u0000]+/g;

/** Model shorthand: a one-line ` ```x``` ` block (not GFM, but Slack renders
 * it) — lifted before the fence walk can misread its backticks. */
const INLINE_FENCE_RE = /```[^`\n]+```/g;

/**
 * Emphasis markers inside a link label are STRIPPED, not converted: Slack
 * applies no formatting inside `<url|label>`, so any surviving marker would
 * render literally.
 */
const stripLabelEmphasis = (label: string): string =>
  label
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1");

export const markdownToMrkdwn = (raw: string): string => {
  // One line model before any anchor runs (see BOUNDED WORK above), then
  // strip forgeable sentinels, then cap — never splitting a surrogate pair
  // at the cut.
  let input = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/[\u0000\u0001]/g, "");
  if (input.length > MAX_INPUT_CHARS) {
    input = input.slice(0, MAX_INPUT_CHARS);
    const last = input.charCodeAt(input.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) input = input.slice(0, -1);
  }
  const source = escapeSlackText(input);

  // Lift code out before rewriting; restore after. Placeholders wrap the
  // stash index in U+0000, which the entry strip above made unforgeable.
  const stash: string[] = [];
  const lift = (s: string): string => {
    stash.push(s);
    return `\u0000${stash.length - 1}\u0000`;
  };

  // Fenced blocks: the one-line shorthand first, then a single line-walk
  // pairs multi-line fences per GFM — a closer is a run of the SAME
  // character at least as long as the opener with only trailing whitespace;
  // an unclosed opener runs to the end of the message; a lone trailing
  // fence line stays prose. The rebuild normalizes every fence to plain
  // ``` — Slack renders only that — which drops info strings and
  // tilde/long-run fences in one move. A walk, not a regex, so a backtick
  // flood or an opener-per-line answer stays linear (see BOUNDED WORK).
  let text = source.replace(INLINE_FENCE_RE, lift);
  {
    const lines = text.split("\n");
    const out: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const marker = line[0] === "`" || line[0] === "~" ? line[0] : "";
      let run = 0;
      while (run < line.length && line[run] === marker) run += 1;
      if (marker === "" || run < 3 || i === lines.length - 1) {
        out.push(line);
        continue;
      }
      let close = -1;
      for (let j = i + 1; j < lines.length; j += 1) {
        const cand = lines[j] ?? "";
        let n = 0;
        while (n < cand.length && cand[n] === marker) n += 1;
        if (n >= run && /^[ \t]*$/.test(cand.slice(n))) {
          close = j;
          break;
        }
      }
      const body = lines
        .slice(i + 1, close === -1 ? lines.length : close)
        .join("\n");
      out.push(lift(body ? `\`\`\`\n${body}\n\`\`\`` : "```\n```"));
      i = close === -1 ? lines.length : close;
    }
    text = out.join("\n");
  }
  text = text.replace(/`[^`\n]+`/g, lift);

  // Images: mrkdwn has none — keep the alt text and the bare URL (Slack
  // unfurls it). Before links, whose pattern is a subset; the emitted URL
  // is protected by the bare-URL lift below.
  text = text.replace(IMAGE_RE, (_m, alt: string, url: string) =>
    alt ? `${alt}: ${url}` : url,
  );

  // Links: [label](url) → <url|label>, lifted immediately so nothing
  // downstream can rewrite the URL or conjure a raw `>` into the label
  // (labels are single-line for the same reason). http(s) only — a
  // javascript: or data: link collapses to plain text.
  text = text.replace(LINK_RE, (_m, label: string, url: string) =>
    lift(`<${url}|${stripLabelEmphasis(label)}>`),
  );

  // Autolinks: `<https://…>` arrived escaped; rebuild as real links.
  text = text.replace(AUTOLINK_RE, (_m, url: string) => lift(`<${url}>`));

  // Bare URLs: Slack auto-links them server-side; lift them so the style
  // and dash passes cannot rewrite characters inside them. A trailing
  // emphasis run stays behind as text — it is a closing marker, not URL
  // (`**bold https://x.com** now` must still pair).
  text = text.replace(BARE_URL_RE, (m) => {
    const tail = /[*_~]+$/.exec(m)?.[0] ?? "";
    return `${lift(tail ? m.slice(0, -tail.length) : m)}${tail}`;
  });

  // Blockquotes: the markdown `>` arrived escaped; re-arm it as Slack's own
  // line-start quote marker (pure formatting — it cannot mention or ping).
  // Nesting flattens to one level. AFTER the lifts, so a quote marker can
  // never appear inside a link label or lifted span.
  text = text.replace(/^(?:&gt; ?)+/gm, "> ");

  // GFM tables → an aligned monospace block. Slack has no table syntax, so
  // pipes render as a wall of text; a code fence with padded columns is the
  // one readable shape. Detected line-wise (a row line, a `|---|` separator
  // line, then more row lines), converted, and LIFTED whole so the style
  // passes below cannot touch it. Cell emphasis markers are stripped (a code
  // block renders them literally); lifted spans inside cells restore in the
  // final DAG pass — their placeholder is 3 chars, so padding drifts a
  // little on such rows rather than breaking. A row-line group WITHOUT a
  // separator is not a table and stays prose (the accepted-gaps contract:
  // degrade readable, never mangle).
  {
    const isRow = (line: string): boolean => /^[ \t]*\|.*\|[ \t]*$/.test(line);
    const isSeparator = (line: string): boolean =>
      /^[ \t]*\|(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*$/.test(line);
    const cellsOf = (line: string): string[] =>
      line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => stripLabelEmphasis(cell.trim()));

    const lines = text.split("\n");
    const out: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (!(isRow(line) && isSeparator(lines[i + 1] ?? ""))) {
        out.push(line);
        continue;
      }
      const rows: string[][] = [cellsOf(line)];
      let j = i + 2;
      while (j < lines.length && isRow(lines[j] ?? "")) {
        rows.push(cellsOf(lines[j] ?? ""));
        j += 1;
      }
      const columns = Math.max(...rows.map((r) => r.length));
      const widths = Array.from({ length: columns }, (_, c) =>
        Math.max(...rows.map((r) => (r[c] ?? "").length)),
      );
      const render = (row: string[]): string =>
        widths
          .map((w, c) => (row[c] ?? "").padEnd(w))
          .join("  ")
          .trimEnd();
      const body = [
        render(rows[0] ?? []),
        widths.map((w) => "-".repeat(w)).join("  "),
        ...rows.slice(1).map(render),
      ].join("\n");
      out.push(lift(`\`\`\`\n${body}\n\`\`\``));
      i = j - 1;
    }
    text = out.join("\n");
  }

  // Horizontal rules → a blank separator (Slack renders --- literally).
  // Early — before the bullet pass can read `- - -` as a list item and
  // before the emphasis passes can read `***`; spaced GFM forms included.
  text = text.replace(/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "");

  // Bold: **x** / __x__ → *x*. Single-line (Slack styling cannot cross a
  // newline, and a cross-line pair would corrupt the lines between).
  // Emitted through a sentinel (U+0001) so the italics pass below cannot
  // re-read the produced single asterisks as its own marker; restored at
  // the end.
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "\u0001$1\u0001");
  text = text.replace(/__([^_\n]+)__/g, "\u0001$1\u0001");

  // Italics: *x* → _x_ (Slack's underscore form), single-line. The bold
  // output is hidden behind sentinels, so any surviving single-asterisk
  // pair is genuine italics; the marker must not touch whitespace (a*b*c
  // stays arithmetic) and the single-char alternative refuses `*`.
  text = text.replace(
    /(^|[\s(])\*([^*\s][^*\n]*[^*\s]|[^*\s])\*(?=[\s).,!?:;]|$)/gm,
    "$1_$2_",
  );

  // Strikethrough: ~~x~~ → ~x~, single-line (fences are in the stash).
  text = text.replace(/~~([^~\n]+)~~/g, "~$1~");

  // Headings: Slack has none — a bold line is the convention. AFTER the
  // emphasis passes, so a bold heading collapses cleanly: interior bold
  // sentinels drop (bold-inside-bold is meaningless), stash placeholders
  // stay (lifted code inside a heading must restore). A trailing closing
  // run (` ## `) is markdown syntax — stripped only behind a space, so
  // `## C#` keeps its `#`. Horizontal whitespace only: `##` alone must not
  // swallow the next line.
  text = text.replace(/^#{1,6}[ \t]+(.+)$/gm, (_m, title: string) => {
    const clean = title
      .replace(/\u0001/g, "")
      .replace(/[ \t]+#+[ \t]*$/, "")
      .trim();
    return clean ? `\u0001${clean}\u0001` : "";
  });

  // Bullet lists: -/*/+ markers → •, preserving two-space indent levels.
  // Horizontal whitespace ONLY on both sides of the marker: `\s` would let
  // the indent capture chew newline runs quadratically, and a bare `-`
  // line is not a bullet and must not join the next line.
  text = text.replace(
    /^([ \t]*)[-*+][ \t]+/gm,
    (_m, indent: string) => `${indent}• `,
  );

  // Em/en dashes → a plain hyphen (house style: no em dashes in agent
  // prose). Horizontal whitespace only — a dash at a line boundary must not
  // join lines — and URLs are already lifted, so links stay intact.
  text = text.replace(/[ \t]*[—–][ \t]*/g, " - ");

  // Restore bold, then the lifted spans. A stash entry can itself contain
  // placeholders for EARLIER lifts (inline code inside a heading, code
  // beside a bare URL), so restore until none remain: the references form a
  // DAG — an entry only points at smaller indices — and the loop cap is a
  // pure backstop, never the terminator.
  text = text.replace(/\u0001([^\u0001]*)\u0001/g, "*$1*");
  for (let i = 0; i <= stash.length && text.includes("\u0000"); i += 1) {
    text = text.replace(/\u0000(\d+)\u0000/g, (_m, idx: string) => {
      return stash[Number(idx)] ?? "";
    });
  }
  // Defense in depth: nothing converter-internal may reach Slack.
  return text.replace(/[\u0000\u0001]/g, "");
};
