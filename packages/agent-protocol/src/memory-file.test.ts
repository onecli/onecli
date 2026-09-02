import { describe, expect, it } from "vitest";
import {
  MAX_MEMORY_WRITE_BYTES,
  MEMORY_FILE_MANAGED_COMMENT,
  flattenToLine,
  isUnmodifiedProjection,
  memoryFileFitsFrame,
  parseMemoryFile,
  renderMemoryFile,
  type MemoryFileFields,
} from "./memory-file";
import { MAX_SYNC_PART_BYTES, syncFrameByteLength } from "./transport";
import { supervisorMessageSchema, workItemSchema } from "./transport";
import { runnerMemoryWriteRequestSchema } from "./runner-wire";

const memory = (over: Partial<MemoryFileFields> = {}): MemoryFileFields => ({
  key: "deploy-notes",
  title: "Deploy notes",
  description: "How the team ships",
  content: "Ship on Tuesdays.\n\nNever on Fridays.",
  ...over,
});

describe("renderMemoryFile", () => {
  it("emits frontmatter, checksum, managed comment, content", () => {
    const rendered = renderMemoryFile(memory());
    expect(rendered).toContain("key: deploy-notes");
    expect(rendered).toContain("title: >-\n  Deploy notes");
    expect(rendered).toContain("description: >-\n  How the team ships");
    expect(rendered).toMatch(/^checksum: [0-9a-f]{64}$/m);
    expect(rendered).toContain(MEMORY_FILE_MANAGED_COMMENT);
    expect(rendered.endsWith("Never on Fridays.\n")).toBe(true);
  });

  it("omits absent title/description lines", () => {
    const rendered = renderMemoryFile(
      memory({ title: null, description: null }),
    );
    expect(rendered).not.toContain("title:");
    expect(rendered).not.toContain("description:");
  });

  it("folds hostile metadata into a single safe line", () => {
    const rendered = renderMemoryFile(memory({ title: "a\nb: c --- '\"" }));
    expect(rendered).toContain("title: >-\n  a b: c --- '\"");
  });
});

describe("parse(render(m)) ≡ m — the property the two sides live by", () => {
  const cases: MemoryFileFields[] = [
    memory(),
    memory({ title: null, description: null }),
    memory({ title: null, description: "only description" }),
    memory({ content: "one line" }),
    memory({ content: "code:\n\n```md\n---\nkey: fake\n---\n```\ndone" }),
    memory({ content: "checksum: not-a-real-one\nbody continues" }),
    memory({ title: 'quoted "title" with: colons', description: "d --- d" }),
    memory({ content: "多字节内容，换行\n\n第二段。" }),
    memory({ content: `${"x".repeat(5_000)}\n\ntail` }),
  ];

  it.each(cases.map((m, i) => [i, m] as const))("case %d", (_i, m) => {
    const parsed = parseMemoryFile(renderMemoryFile(m));
    expect(parsed.content).toBe(m.content);
    expect(parsed.title).toBe(m.title ? flattenToLine(m.title) : undefined);
    expect(parsed.description).toBe(
      m.description ? flattenToLine(m.description) : undefined,
    );
  });
});

describe("parseMemoryFile tolerance", () => {
  it("no frontmatter → whole file is content", () => {
    expect(parseMemoryFile("just notes\nmore notes")).toEqual({
      content: "just notes\nmore notes",
    });
  });

  it("strips a BOM and accepts CRLF delimiters", () => {
    const bom = String.fromCharCode(0xfeff);
    const raw = `${bom}---\r\ntitle: T\r\n---\r\nbody\r\n`;
    expect(parseMemoryFile(raw)).toEqual({ title: "T", content: "body" });
  });

  it("plain and quoted scalars parse; unknown fields are ignored", () => {
    const raw = [
      "---",
      "key: ignored-in-favor-of-filename",
      'title: "Quoted"',
      "unknown: field",
      "description: plain text",
      "---",
      "body",
    ].join("\n");
    expect(parseMemoryFile(raw)).toEqual({
      title: "Quoted",
      description: "plain text",
      content: "body",
    });
  });

  it("unclosed frontmatter reads as content", () => {
    const raw = "---\ntitle: dangling\nbody";
    expect(parseMemoryFile(raw).content).toBe(raw.trim());
    expect(parseMemoryFile(raw).title).toBeUndefined();
  });

  it("drops the managed comment (current and legacy)", () => {
    expect(parseMemoryFile(`${MEMORY_FILE_MANAGED_COMMENT}\n\nbody`)).toEqual({
      content: "body",
    });
    expect(
      parseMemoryFile("<!-- Managed by OneCLI — read-only -->\n\nbody"),
    ).toEqual({ content: "body" });
  });

  it("keeps a comment that is not the first content line", () => {
    const parsed = parseMemoryFile(`body\n${MEMORY_FILE_MANAGED_COMMENT}`);
    expect(parsed.content).toBe(`body\n${MEMORY_FILE_MANAGED_COMMENT}`);
  });
});

describe("isUnmodifiedProjection — the self-authenticating law", () => {
  it("accepts an untouched render", () => {
    expect(isUnmodifiedProjection(renderMemoryFile(memory()))).toBe(true);
  });

  it("rejects any edit, however small", () => {
    const rendered = renderMemoryFile(memory());
    expect(isUnmodifiedProjection(`${rendered} `)).toBe(false);
    expect(
      isUnmodifiedProjection(rendered.replace("Tuesdays", "Mondays")),
    ).toBe(false);
    expect(
      isUnmodifiedProjection(rendered.replace("Deploy notes", "Own notes")),
    ).toBe(false);
  });

  it("rejects a file with no checksum (agent-created)", () => {
    expect(isUnmodifiedProjection("---\ntitle: t\n---\nbody\n")).toBe(false);
    expect(isUnmodifiedProjection("plain body")).toBe(false);
  });

  it("rejects a stale checksum after content swap between two renders", () => {
    const a = renderMemoryFile(memory({ content: "aaa" }));
    const b = renderMemoryFile(memory({ content: "bbb" }));
    const bChecksum = /^checksum: ([0-9a-f]{64})$/m.exec(b)?.[1] ?? "";
    const forged = a.replace(
      /^checksum: [0-9a-f]{64}$/m,
      `checksum: ${bChecksum}`,
    );
    expect(isUnmodifiedProjection(forged)).toBe(false);
  });

  it("a checksum-looking line inside content does not shadow the frontmatter one", () => {
    const withDecoy = memory({
      content: `checksum: ${"a".repeat(64)}\nreal body`,
    });
    expect(isUnmodifiedProjection(renderMemoryFile(withDecoy))).toBe(true);
  });
});

describe("memoryFileFitsFrame", () => {
  it("accepts a maxed ASCII memory and refuses a maxed CJK one", () => {
    expect(memoryFileFitsFrame(memory({ content: "x".repeat(100_000) }))).toBe(
      true,
    );
    expect(memoryFileFitsFrame(memory({ content: "字".repeat(100_000) }))).toBe(
      false,
    );
  });

  it("gates on ROUND-TRIP deliverability: refuses content the dashboard would take but the harvester could never send back", () => {
    // ~60k CJK chars ≈ 180KB UTF-8: fits the 200KB down-frame but exceeds
    // the 150KB up-frame. Before the round-trip gate this was savable
    // through the dashboard and then permanently unharvestable — the
    // agent's own edit to it lost forever. The predicate must refuse it.
    const fields = memory({ content: "字".repeat(60_000) });
    const downOnly =
      syncFrameByteLength({
        kind: "skills.changed",
        generation: 2_147_483_647,
        part: 256,
        of: 256,
        files: [
          {
            path: `memory/${fields.key}.md`,
            content: renderMemoryFile(fields),
          },
        ],
      }) <= MAX_SYNC_PART_BYTES;
    const up =
      syncFrameByteLength({
        kind: "memory.write",
        writeId: "x".repeat(100),
        key: fields.key,
        content: fields.content,
        ...(fields.title ? { title: fields.title } : {}),
        ...(fields.description ? { description: fields.description } : {}),
      }) <= MAX_MEMORY_WRITE_BYTES;
    // The band this test pins: down-frame OK, up-frame NOT — the round-trip
    // gate must say no (the AND of both).
    expect(downOnly).toBe(true);
    expect(up).toBe(false);
    expect(memoryFileFitsFrame(fields)).toBe(false);
  });
});

describe("wire frames", () => {
  it("memory.write parses and enforces the key pattern", () => {
    expect(
      supervisorMessageSchema.safeParse({
        kind: "memory.write",
        writeId: "w1",
        key: "deploy-notes",
        content: "body",
      }).success,
    ).toBe(true);
    expect(
      supervisorMessageSchema.safeParse({
        kind: "memory.write",
        writeId: "w1",
        key: "Bad Key",
        content: "body",
      }).success,
    ).toBe(false);
  });

  it("memory.write.result work item parses", () => {
    expect(
      workItemSchema.safeParse({
        kind: "memory.write.result",
        writeId: "w1",
        ok: true,
        created: true,
        revisionSeq: 1,
      }).success,
    ).toBe(true);
  });

  it("runner memory-write request enforces the serialized byte budget", () => {
    const base = {
      sandboxId: "sb1",
      key: "big",
      content: "字".repeat(60_000), // ~180KB UTF-8 > 150k budget
    };
    expect(runnerMemoryWriteRequestSchema.safeParse(base).success).toBe(false);
    expect(
      runnerMemoryWriteRequestSchema.safeParse({
        ...base,
        content: "x".repeat(60_000),
      }).success,
    ).toBe(true);
  });
});
