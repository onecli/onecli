import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DUPLICATE_NAME_PROBLEM,
  GitHubReadError,
  decodeUtf8Text,
  discoverSkills,
  fetchBranchHead,
  fileFitsSyncFrame,
  isSafeSkillFilePath,
  listSkills,
  markDuplicateNames,
  parseSkillFrontmatter,
  skillFolderTree,
  skillProblem,
  treeOfSkills,
  LIBRARY_MAX_LISTED_SKILLS,
  type RepoSkill,
  type RepoTree,
  type RepoTreeEntry,
} from "./github-skill-repo";

const blob = (path: string, mode = "100644"): RepoTreeEntry => ({
  path,
  type: "blob",
  mode,
  sha: `sha-${path}`,
  size: 10,
});

const tree = (entries: RepoTreeEntry[]): RepoTree => ({
  commitSha: "c0ffee",
  entries,
  truncated: false,
});

describe("discoverSkills", () => {
  it("finds skills in a Claude marketplace layout, grouped by plugin", () => {
    const found = discoverSkills(
      tree([
        blob(".claude-plugin/marketplace.json"),
        blob("plugins/data-tools/.claude-plugin/plugin.json"),
        blob("plugins/data-tools/skills/snowflake/SKILL.md"),
        blob("plugins/data-tools/skills/snowflake/references/tables.md"),
        blob("plugins/data-tools/skills/dbt/SKILL.md"),
        blob("plugins/eng/hooks/hooks.json"),
      ]),
    );
    expect(found).toEqual([
      {
        path: "plugins/data-tools/skills/dbt",
        folder: "dbt",
        plugin: "data-tools",
        fileCount: 1,
      },
      {
        path: "plugins/data-tools/skills/snowflake",
        folder: "snowflake",
        plugin: "data-tools",
        fileCount: 2,
      },
    ]);
  });

  it("finds skills in other tools' layouts, with no plugin", () => {
    const found = discoverSkills(
      tree([
        blob(".agents/skills/review/SKILL.md"),
        blob(".github/skills/release/SKILL.md"),
        blob("docs/onboarding/SKILL.md"),
      ]),
    );
    expect(found.map((s) => [s.folder, s.plugin])).toEqual([
      ["review", null],
      ["release", null],
      ["onboarding", null],
    ]);
  });

  it("treats a nested SKILL.md as part of the outer skill", () => {
    const found = discoverSkills(
      tree([
        blob("skills/outer/SKILL.md"),
        blob("skills/outer/examples/inner/SKILL.md"),
      ]),
    );
    expect(found.map((s) => s.path)).toEqual(["skills/outer"]);
    expect(found[0]?.fileCount).toBe(2);
  });

  it("never counts a symlinked SKILL.md or a root-level one", () => {
    const found = discoverSkills(
      tree([blob("SKILL.md"), blob("skills/linked/SKILL.md", "120000")]),
    );
    expect(found).toEqual([]);
  });

  it("keeps a nested skill inside its outer one even when a sibling sorts between them", () => {
    // "a/b" < "a/b-c" < "a/b/c": the folder after the outer one is not its
    // child, so a last-outer-only check would wrongly list a/b/c.
    const found = discoverSkills(
      tree([
        blob("a/b/SKILL.md"),
        blob("a/b-c/SKILL.md"),
        blob("a/b/c/SKILL.md"),
        blob("a/b/c/notes.md"),
      ]),
    );
    expect(found.map((s) => [s.path, s.fileCount])).toEqual([
      ["a/b", 3],
      ["a/b-c", 1],
    ]);
  });

  it("walks a 100,000-entry tree in one pass", () => {
    // 20,000 skill folders, four files each: the old per-skill scan of
    // every blob took seconds here and blocked the API's event loop.
    const entries: RepoTreeEntry[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      entries.push(blob(`s/${i}/SKILL.md`));
      for (let f = 0; f < 4; f += 1) entries.push(blob(`s/${i}/r/${f}.md`));
    }
    const started = performance.now();
    const found = discoverSkills(tree(entries));
    expect(performance.now() - started).toBeLessThan(500);
    expect(found).toHaveLength(20_000);
    expect(found.every((s) => s.fileCount === 5)).toBe(true);
  });
});

describe("treeOfSkills", () => {
  it("keeps only the entries inside the given skill folders", () => {
    const pruned = treeOfSkills(
      tree([
        blob("README.md"),
        blob("skills/a/SKILL.md"),
        blob("skills/a/ref/x.md"),
        blob("skills/ab/SKILL.md"),
        blob("skills/b/SKILL.md"),
      ]),
      ["skills/a", "skills/b"],
    );
    expect(pruned.entries.map((e) => e.path)).toEqual([
      "skills/a/SKILL.md",
      "skills/a/ref/x.md",
      "skills/b/SKILL.md",
    ]);
  });
});

describe("parseSkillFrontmatter", () => {
  it("reads plain, quoted and folded values", () => {
    expect(
      parseSkillFrontmatter(
        '---\nname: snowflake\ndescription: "Use when: querying"\n---\nbody',
      ),
    ).toEqual({ name: "snowflake", description: "Use when: querying" });
    expect(
      parseSkillFrontmatter(
        "---\nname: dbt\ndescription: >-\n  How our dbt models\n  are organized\nother: x\n---\n",
      ),
    ).toEqual({ name: "dbt", description: "How our dbt models are organized" });
  });

  it("handles CRLF and a BOM, and answers nulls without frontmatter", () => {
    expect(
      parseSkillFrontmatter(
        "\uFEFF---\r\nname: a\r\ndescription: b\r\n---\r\n",
      ),
    ).toEqual({ name: "a", description: "b" });
    expect(parseSkillFrontmatter("# just markdown")).toEqual({
      name: null,
      description: null,
    });
  });
});

describe("skillProblem", () => {
  const skill = {
    path: "skills/snowflake",
    folder: "snowflake",
    plugin: null,
    fileCount: 1,
  };
  it("accepts a standard skill", () => {
    expect(
      skillProblem(skill, { name: "snowflake", description: "d" }),
    ).toBeNull();
  });
  it("refuses missing, malformed, mismatched and reserved names", () => {
    expect(skillProblem(skill, { name: null, description: "d" })).toMatch(
      /no name/,
    );
    expect(
      skillProblem(skill, { name: "Snow Flake", description: "d" }),
    ).toMatch(/lowercase/);
    expect(skillProblem(skill, { name: "other", description: "d" })).toMatch(
      /doesn't match its folder/,
    );
    expect(
      skillProblem(
        { ...skill, folder: "onecli-gateway" },
        { name: "onecli-gateway", description: "d" },
      ),
    ).toMatch(/reserved/);
  });
  it("refuses a missing or too-long description", () => {
    expect(
      skillProblem(skill, { name: "snowflake", description: null }),
    ).toMatch(/no description/);
    expect(
      skillProblem(skill, { name: "snowflake", description: "x".repeat(1025) }),
    ).toMatch(/1,024/);
  });
});

describe("isSafeSkillFilePath", () => {
  it("allows nested relative paths within the depth cap", () => {
    expect(isSafeSkillFilePath("references/api/v2.md")).toBe(true);
    expect(isSafeSkillFilePath("SKILL.md")).toBe(true);
  });
  it("refuses traversal, absolute, backslash and too-deep paths", () => {
    for (const bad of [
      "../x",
      "a/../b",
      "/etc/passwd",
      "a\\b",
      "a//b",
      "a/b/c/d/e",
      "",
    ]) {
      expect(isSafeSkillFilePath(bad), bad).toBe(false);
    }
  });
});

describe("decodeUtf8Text", () => {
  it("decodes UTF-8 text and refuses binary", () => {
    expect(decodeUtf8Text(new TextEncoder().encode("héllo 世界"))).toBe(
      "héllo 世界",
    );
    expect(decodeUtf8Text(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0]))).toBe(
      null,
    );
    expect(decodeUtf8Text(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe(null);
  });
});

describe("markDuplicateNames", () => {
  const skill = (path: string, name: string, problem: string | null = null) =>
    ({
      path,
      folder: name,
      plugin: null,
      fileCount: 1,
      name,
      description: "d",
      problem,
      conflicts: [],
    }) satisfies RepoSkill;

  it("marks every folder claiming the same name, each with the others", () => {
    const out = markDuplicateNames([
      skill("a/review", "review"),
      skill("b/review", "review"),
      skill("c/review", "review"),
      skill("d/solo", "solo"),
    ]);
    expect(out.map((s) => [s.path, s.problem, s.conflicts])).toEqual([
      ["a/review", DUPLICATE_NAME_PROBLEM, ["b/review", "c/review"]],
      ["b/review", DUPLICATE_NAME_PROBLEM, ["a/review", "c/review"]],
      ["c/review", DUPLICATE_NAME_PROBLEM, ["a/review", "b/review"]],
      ["d/solo", null, []],
    ]);
  });

  it("an already-invalid folder doesn't claim the name", () => {
    const out = markDuplicateNames([
      skill("a/review", "review"),
      skill("b/review", "review", "Name doesn't match its folder"),
    ]);
    expect(out[0]?.problem).toBeNull();
    expect(out[1]?.problem).toMatch(/doesn't match/);
  });
});

describe("fileFitsSyncFrame", () => {
  it("measures the serialized frame, not the raw size", () => {
    // 110 KB raw either way; quotes double under JSON escaping.
    expect(
      fileFitsSyncFrame("s", {
        path: "SKILL.md",
        content: "a".repeat(110_000),
      }),
    ).toBe(true);
    expect(
      fileFitsSyncFrame("s", {
        path: "SKILL.md",
        content: '"'.repeat(110_000),
      }),
    ).toBe(false);
  });
});

describe("GitHub requests", () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (status: number, body: unknown, headers = {}) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify(body), { status, headers }),
      ),
    );

  it("a rate limit carries GitHub's wait: retry-after, then the reset time, then a minute", async () => {
    respond(429, { message: "slow down" }, { "retry-after": "120" });
    await expect(fetchBranchHead("t", "o/r", "main")).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 120,
    });
    const reset = Math.floor(Date.now() / 1000) + 300;
    respond(
      403,
      { message: "API rate limit exceeded" },
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
    );
    const err = await fetchBranchHead("t", "o/r", "main").catch((e) => e);
    expect(err).toBeInstanceOf(GitHubReadError);
    expect(err.retryAfterSeconds).toBeGreaterThan(290);
    respond(403, { message: "You have exceeded a secondary rate limit" });
    await expect(fetchBranchHead("t", "o/r", "main")).rejects.toMatchObject({
      retryAfterSeconds: 60,
    });
  });

  it("a plain 403 or 404 is not a rate limit", async () => {
    respond(403, { message: "Resource not accessible by integration" });
    await expect(fetchBranchHead("t", "o/r", "main")).rejects.toMatchObject({
      status: 403,
      retryAfterSeconds: null,
    });
  });

  it("a request that never answers fails as a timeout, not a hang", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("timed out", "TimeoutError");
      }),
    );
    await expect(fetchBranchHead("t", "o/r", "main")).rejects.toMatchObject({
      status: 504,
    });
  });

  it("discovery reads at most 8 SKILL.md files at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        const name = decodeURIComponent(url.split("/git/blobs/")[1] ?? "");
        const text = `---\nname: ${name}\ndescription: d\n---\n`;
        return new Response(
          JSON.stringify({
            encoding: "base64",
            content: Buffer.from(text).toString("base64"),
          }),
        );
      }),
    );
    const entries = Array.from({ length: 30 }, (_, i) => ({
      path: `skills/s${i}/SKILL.md`,
      type: "blob" as const,
      mode: "100644",
      sha: `s${i}`,
      size: 40,
    }));
    const { skills } = await listSkills("t", "o/r", tree(entries));
    expect(skills).toHaveLength(30);
    expect(skills.every((s) => s.problem === null)).toBe(true);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("a SKILL.md over the download cap is refused without downloading it", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { skills } = await listSkills(
      "t",
      "o/r",
      tree([{ ...blob("skills/big/SKILL.md"), size: 200_000 }]),
    );
    expect(skills[0]?.problem).toMatch(/larger than 120 KB/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reads at most LIBRARY_MAX_LISTED_SKILLS skills and says the list is partial", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    // Every SKILL.md over the download cap: listed with a problem, never
    // downloaded, so the cap is what bounds the work.
    const entries = Array.from(
      { length: LIBRARY_MAX_LISTED_SKILLS + 5 },
      (_, i) => ({
        ...blob(`s/${String(i).padStart(5, "0")}/SKILL.md`),
        size: 200_000,
      }),
    );
    const { skills, capped } = await listSkills("t", "o/r", tree(entries));
    expect(skills).toHaveLength(LIBRARY_MAX_LISTED_SKILLS);
    expect(capped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a truncated listing reads the skill's folder on its own", async () => {
    const answers: Record<string, unknown> = {
      c0ffee: { tree: [{ path: "plugins", type: "tree", sha: "t1" }] },
      t1: { tree: [{ path: "skills", type: "tree", sha: "t2" }] },
      t2: { tree: [{ path: "review", type: "tree", sha: "t3" }] },
      "t3?recursive=1": {
        truncated: false,
        tree: [blob("SKILL.md"), blob("refs/a.md")],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(answers[url.split("/git/trees/")[1] ?? ""] ?? {}),
          ),
      ),
    );
    const folder = await skillFolderTree(
      "t",
      "o/r",
      { commitSha: "c0ffee", entries: [], truncated: true },
      "plugins/skills/review",
    );
    expect(folder?.entries.map((e) => e.path)).toEqual([
      "plugins/skills/review/SKILL.md",
      "plugins/skills/review/refs/a.md",
    ]);
    expect(
      await skillFolderTree(
        "t",
        "o/r",
        { commitSha: "c0ffee", entries: [], truncated: true },
        "plugins/gone/review",
      ),
    ).toBeNull();
  });
});
