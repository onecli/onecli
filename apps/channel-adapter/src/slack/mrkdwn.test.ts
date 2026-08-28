import { describe, expect, it } from "vitest";
import { markdownToMrkdwn } from "./mrkdwn";

// Built with fromCharCode so no literal control byte sits in this file.
const NUL = String.fromCharCode(0);
const SOH = String.fromCharCode(1);

describe("markdownToMrkdwn", () => {
  it("converts the exact shape from the Gmail answer (the screenshot case)", () => {
    // Fictional fixture — only the markdown SHAPE matters, and this file
    // syncs to the public OSS mirror.
    const input = [
      "Your most recent email is:",
      "",
      "- **From:** Dana Fox <dana@example.com>",
      "- **Subject:** Re: Quarterly report",
      "- **Date:** Wed, 1 Jan 2025, 09:00 UTC",
    ].join("\n");
    const out = markdownToMrkdwn(input);
    expect(out).toContain("• *From:* Dana Fox &lt;dana@example.com&gt;");
    expect(out).toContain("• *Subject:* Re: Quarterly report");
    expect(out).not.toContain("**");
    expect(out).not.toContain("- *");
  });

  it("turns headings into bold lines", () => {
    expect(markdownToMrkdwn("## Summary\ntext")).toBe("*Summary*\ntext");
  });

  it("collapses a bold heading into one bold line, not literal asterisks", () => {
    expect(markdownToMrkdwn("## **Title**")).toBe("*Title*");
    expect(markdownToMrkdwn("# **Summary** of runs\nbody")).toBe(
      "*Summary of runs*\nbody",
    );
  });

  it("strips a trailing closing-hash run but keeps a bare trailing hash", () => {
    expect(markdownToMrkdwn("## Title ##")).toBe("*Title*");
    expect(markdownToMrkdwn("## C#")).toBe("*C#*");
  });

  it("does not let an empty heading swallow the next line", () => {
    expect(markdownToMrkdwn("##\nDetails here")).toBe("##\nDetails here");
  });

  it("converts links to Slack's <url|label> form, http(s) only", () => {
    expect(markdownToMrkdwn("[docs](https://example.com/a)")).toBe(
      "<https://example.com/a|docs>",
    );
    // A dangerous protocol never becomes a live link.
    expect(markdownToMrkdwn("[x](javascript:alert(1))")).toBe(
      "[x](javascript:alert(1))",
    );
  });

  it("keeps balanced parens inside a link URL (Wikipedia-style)", () => {
    expect(
      markdownToMrkdwn("[wiki](https://en.wikipedia.org/wiki/Foo_(bar))"),
    ).toBe("<https://en.wikipedia.org/wiki/Foo_(bar)|wiki>");
  });

  it("drops a markdown link title", () => {
    expect(markdownToMrkdwn('[x](https://ex.com "Title")')).toBe(
      "<https://ex.com|x>",
    );
  });

  it("strips emphasis markers inside a link label (Slack renders none there)", () => {
    expect(markdownToMrkdwn("[**docs**](https://example.com)")).toBe(
      "<https://example.com|docs>",
    );
  });

  it("never lets the dash pass rewrite a URL", () => {
    expect(markdownToMrkdwn("[x](https://ex.com/a–b)")).toBe(
      "<https://ex.com/a–b|x>",
    );
    expect(markdownToMrkdwn("see https://ex.com/a–b now")).toBe(
      "see https://ex.com/a–b now",
    );
  });

  it("never lets the emphasis passes rewrite a bare URL", () => {
    expect(markdownToMrkdwn("see https://x.com/__init__/ docs")).toBe(
      "see https://x.com/__init__/ docs",
    );
  });

  it("pairs bold across a bare URL (a trailing marker run is not URL)", () => {
    expect(markdownToMrkdwn("**Check https://example.com** now")).toBe(
      "*Check https://example.com* now",
    );
  });

  it("converts **bold** and *italic* without eating each other", () => {
    expect(markdownToMrkdwn("**bold** and *ital*")).toBe("*bold* and _ital_");
    // Mid-word asterisks (arithmetic) stay put.
    expect(markdownToMrkdwn("2*3*4")).toBe("2*3*4");
  });

  it("renders a full-line ***bold italic*** as italic bold", () => {
    expect(markdownToMrkdwn("***x***")).toBe("_*x*_");
  });

  it("treats a full-line *emphasis* as italics (GFM semantics)", () => {
    expect(markdownToMrkdwn("*done*")).toBe("_done_");
  });

  it("keeps multi-line emphasis literal instead of corrupting the lines between", () => {
    expect(markdownToMrkdwn("**a\nb** end")).toBe("**a\nb** end");
    expect(markdownToMrkdwn("***\n**bold**")).toBe("\n*bold*");
  });

  it("leaves fenced and inline code untouched", () => {
    const input = "run `a ** b` and\n```\n**not bold** # not heading\n```";
    const out = markdownToMrkdwn(input);
    expect(out).toContain("`a ** b`");
    expect(out).toContain("**not bold** # not heading");
  });

  it("drops the fence language tag (Slack would print it as content)", () => {
    expect(markdownToMrkdwn("```js\nconst a = 1;\n```")).toBe(
      "```\nconst a = 1;\n```",
    );
    expect(markdownToMrkdwn("```x```")).toBe("```x```");
  });

  it("normalizes a tilde fence to backticks instead of shredding it", () => {
    expect(markdownToMrkdwn("~~~\nx = ~~1~~\n~~~")).toBe("```\nx = ~~1~~\n```");
  });

  it("runs an unclosed fence to the end of the message (GFM rule)", () => {
    expect(markdownToMrkdwn("Here:\n```js\nconst x = 1;\n**still code**")).toBe(
      "Here:\n```\nconst x = 1;\n**still code**\n```",
    );
  });

  it("pairs a four-backtick fence with its own closer, not an inner fence", () => {
    const out = markdownToMrkdwn("````\n```\ninner\n```\n````");
    expect(out).toContain("inner");
    expect(out).not.toContain("_");
    expect(out).not.toContain(NUL);
  });

  it("escapes Slack's live syntax FIRST — a directive in prose dies", () => {
    const out = markdownToMrkdwn("ping <!channel> **now**");
    expect(out).toBe("ping &lt;!channel&gt; *now*");
  });

  it("keeps a directive inert even inside a link label", () => {
    const out = markdownToMrkdwn("[<!here>](https://example.com)");
    expect(out).toBe("<https://example.com|&lt;!here&gt;>");
  });

  it("re-arms blockquotes while everything inside stays escaped", () => {
    expect(markdownToMrkdwn("> quoted line\nnormal")).toBe(
      "> quoted line\nnormal",
    );
    expect(markdownToMrkdwn("> <!here> **x**")).toBe("> &lt;!here&gt; *x*");
    expect(markdownToMrkdwn("> see [x](https://a.com)")).toBe(
      "> see <https://a.com|x>",
    );
  });

  it("flattens nested quotes and never emits Slack's >>> form", () => {
    expect(markdownToMrkdwn(">>> deep")).toBe("> deep");
    expect(markdownToMrkdwn("> > nested")).toBe("> nested");
  });

  it("quotes a line-start >= exactly as GFM does", () => {
    expect(markdownToMrkdwn(">= 5 required")).toBe("> = 5 required");
  });

  it("converts escaped autolinks into live links, http(s) only", () => {
    expect(markdownToMrkdwn("<https://example.com>")).toBe(
      "<https://example.com>",
    );
    expect(markdownToMrkdwn("<https://a.com?x=1&y=2>")).toBe(
      "<https://a.com?x=1&amp;y=2>",
    );
    expect(markdownToMrkdwn("<javascript:alert(1)>")).toBe(
      "&lt;javascript:alert(1)&gt;",
    );
  });

  it("converts images to alt + URL", () => {
    expect(markdownToMrkdwn("![diagram](https://ex.com/i.png)")).toBe(
      "diagram: https://ex.com/i.png",
    );
    expect(markdownToMrkdwn("![](https://ex.com/i.png)")).toBe(
      "https://ex.com/i.png",
    );
  });

  it("converts list markers and strikethrough", () => {
    expect(markdownToMrkdwn("- one\n  - nested\n~~gone~~")).toBe(
      "• one\n  • nested\n~gone~",
    );
  });

  it("does not read a bare dash line as a bullet", () => {
    expect(markdownToMrkdwn("-\nnext")).toBe("-\nnext");
  });

  it("removes horizontal rules, spaced GFM forms included", () => {
    expect(markdownToMrkdwn("a\n---\nb")).toBe("a\n\nb");
    expect(markdownToMrkdwn("a\n* * *\nb")).toBe("a\n\nb");
    expect(markdownToMrkdwn("a\n- - -\nb")).toBe("a\n\nb");
    expect(markdownToMrkdwn("a\n***\nb")).toBe("a\n\nb");
  });

  it("replaces em and en dashes with a plain hyphen", () => {
    expect(markdownToMrkdwn("No new email — the latest is the same")).toBe(
      "No new email - the latest is the same",
    );
    expect(markdownToMrkdwn("word—word and range–range")).toBe(
      "word - word and range - range",
    );
    // Inside code, dashes are content — untouched.
    expect(markdownToMrkdwn("`a — b`")).toBe("`a — b`");
  });

  it("never joins lines around a dash at a line boundary", () => {
    expect(markdownToMrkdwn("a —\nb")).toBe("a - \nb");
  });

  it("neutralizes forged stash placeholders and bold sentinels", () => {
    expect(markdownToMrkdwn(`code \`x\` then ${NUL}0${NUL} replay`)).toBe(
      "code `x` then 0 replay",
    );
    expect(markdownToMrkdwn(`evil ${SOH}pair${SOH} and **bold**`)).toBe(
      "evil pair and *bold*",
    );
  });

  it("restores nested lifts fully — no placeholder residue", () => {
    expect(markdownToMrkdwn("https://a.com`tag`")).toBe("https://a.com`tag`");
    const out = markdownToMrkdwn("## Head `code` end");
    expect(out).toBe("*Head `code` end*");
    expect(out).not.toContain(NUL);
    expect(out).not.toContain(SOH);
  });

  it("converts CRLF input identically to LF input", () => {
    expect(markdownToMrkdwn("## A\r\n- b")).toBe("*A*\n• b");
    expect(markdownToMrkdwn("```js\r\nconst a = 1;\r\n```")).toBe(
      "```\nconst a = 1;\n```",
    );
  });

  it("normalizes lone CR and U+2028/U+2029 to real line breaks", () => {
    // JS multiline anchors also fire at these, which would otherwise arm
    // the quote marker mid-line — including inside a link label, where a
    // raw > breaks the emitted <url|label>.
    const LS = String.fromCharCode(0x2028);
    expect(markdownToMrkdwn("a\r> b")).toBe("a\n> b");
    expect(markdownToMrkdwn(`a${LS}> b`)).toBe("a\n> b");
    expect(markdownToMrkdwn(`[a${LS}> b](https://x.com)`)).toBe(
      "[a\n> b](https://x.com)",
    );
  });

  it("pairs multiple fences independently", () => {
    expect(markdownToMrkdwn("```\na\n```\nmid **x**\n```\nb\n```")).toBe(
      "```\na\n```\nmid *x*\n```\nb\n```",
    );
  });

  it("leaves a trailing lone fence line as prose", () => {
    expect(markdownToMrkdwn("done\n```")).toBe("done\n```");
  });

  it("caps input at Slack's 40k message limit (longer can never post)", () => {
    expect(markdownToMrkdwn("a".repeat(50_000))).toHaveLength(40_000);
    // The cut never splits a surrogate pair.
    const out = markdownToMrkdwn("x" + "😀".repeat(25_000));
    const last = out.charCodeAt(out.length - 1);
    expect(last < 0xd800 || last > 0xdbff).toBe(true);
  });

  it("stays fast on the known hostile shapes (the quadratic-fence guard)", () => {
    // Pre-fix measurements for these inputs ran 0.7–4.9 SECONDS; the fixed
    // pipeline runs each in single-digit milliseconds. The generous budget
    // absorbs CI noise while still failing any reintroduced quadratic pass.
    const budgetMs = 500;
    const hostile = [
      "`".repeat(60_000),
      "```x\n".repeat(10_000),
      "````a\n".repeat(10_000),
      "<https://x".repeat(4_000),
      "\n".repeat(50_000),
      "> ".repeat(30_000),
    ];
    for (const input of hostile) {
      const start = performance.now();
      markdownToMrkdwn(input);
      expect(performance.now() - start).toBeLessThan(budgetMs);
    }
  });
});

describe("GFM tables", () => {
  it("converts the file-list shape (the Dropbox answer) to an aligned code block", () => {
    const input = [
      "**Files**",
      "| Name | Size | Modified |",
      "|---|---|---|",
      "| onecli-logo-64x64.png | 2.5 KB | 2026-05-14 |",
      "| nanoclaw-logo.png | 217.3 KB | 2026-07-13 |",
    ].join("\n");
    const out = markdownToMrkdwn(input);
    expect(out).toContain("*Files*");
    expect(out).toContain("```");
    // Aligned columns: every row pads to the widest cell.
    expect(out).toContain("Name                   Size      Modified");
    expect(out).toContain("onecli-logo-64x64.png  2.5 KB    2026-05-14");
    expect(out).toContain("nanoclaw-logo.png      217.3 KB  2026-07-13");
    // No raw pipe rows survive.
    expect(out).not.toMatch(/^\|.*\|$/m);
  });

  it("strips cell emphasis (a code block would render the markers literally)", () => {
    const out = markdownToMrkdwn(
      "| **Name** | *State* |\n|---|---|\n| donna | ~~old~~ |",
    );
    expect(out).toContain("Name   State");
    expect(out).toContain("donna  old");
  });

  it("handles alignment colons and ragged rows", () => {
    const out = markdownToMrkdwn("| a | b |\n|:--|--:|\n| 1 |\n| 2 | 3 | 4 |");
    expect(out).toContain("```");
    expect(out).toContain("a  b");
    expect(out).toContain("2  3  4");
  });

  it("leaves pipe lines WITHOUT a separator row as prose", () => {
    const input = "| just | pipes |\n| more | pipes |";
    expect(markdownToMrkdwn(input)).toBe(input);
  });

  it("keeps a table inside a fence untouched (code is content)", () => {
    const input = "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```";
    const out = markdownToMrkdwn(input);
    expect(out).toContain("| a | b |");
    expect(out).toContain("|---|---|");
  });

  it("keeps prose around the table intact", () => {
    const out = markdownToMrkdwn(
      "before\n| a | b |\n|---|---|\n| 1 | 2 |\nafter",
    );
    expect(out.startsWith("before\n")).toBe(true);
    expect(out.endsWith("\nafter")).toBe(true);
  });
});
