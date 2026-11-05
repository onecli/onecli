import { describe, expect, it } from "vitest";
import { crc32, deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { importSkillZip, summarizeSkillFiles } from "./skill-import";
import { ZipError } from "../lib/zip";
import {
  SKILL_LEAVE_OUT_RULES,
  skillCheckCommand,
} from "../lib/skill-import-rules";

/**
 * A tiny ZIP writer for tests: each entry is deflated (or stored), with the
 * Unix mode in the external attributes and a real CRC-32, so the reader sees
 * what `zip -r` on macOS/Linux produces (exec bits, symlinks, folders).
 */
type Entry = {
  path: string;
  data?: string | Buffer;
  mode?: number;
  stored?: boolean;
  /** Lie about the uncompressed size (the bomb guard must not trust it). */
  declaredSize?: number;
  /** Write a wrong CRC-32 (a damaged entry). */
  badCrc?: boolean;
  /** Write the ZIP64 sentinel in the size fields. */
  zip64?: boolean;
};

const makeZip = (entries: Entry[], comment = ""): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const raw = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data ?? "", "utf8");
    const body = entry.stored ? raw : deflateRawSync(raw);
    const method = entry.stored ? 0 : 8;
    const size = entry.zip64 ? 0xffffffff : (entry.declaredSize ?? raw.length);
    const crc = entry.badCrc ? (crc32(raw) ^ 1) >>> 0 : crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = entry.mode ?? (entry.path.endsWith("/") ? 0o040755 : 0o100644);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const commentBuf = Buffer.from(comment, "utf8");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(commentBuf.length, 20);
  return Buffer.concat([...locals, centralBuf, eocd, commentBuf]);
};

const skillMd = (name: string, description = "Use it for tests.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDo the thing.\n`;

const onlySkill = async (zip: Buffer) => {
  const { skills } = await importSkillZip(zip);
  const [skill] = skills;
  if (!skill || skills.length !== 1) throw new Error("expected one skill");
  return skill;
};

describe("importSkillZip", () => {
  it("keeps the whole folder: nested files, data, and runnable scripts", async () => {
    const zip = makeZip([
      { path: "incident-tools/" },
      { path: "incident-tools/SKILL.md", data: skillMd("incident-tools") },
      {
        path: "incident-tools/run",
        data: "#!/usr/bin/env bash\nexec node x\n",
        mode: 0o100755,
      },
      { path: "incident-tools/tools.cjs", data: "#!/usr/bin/env node\n1\n" },
      { path: "incident-tools/playbooks/db.md", data: "# db\n" },
      { path: "incident-tools/fixtures/incidents/a.json", data: "{}" },
    ]);
    const { skills, problems } = await importSkillZip(zip);
    expect(problems).toEqual([]);
    const [skill] = skills;
    expect(skills).toHaveLength(1);
    expect(skill?.name).toBe("incident-tools");
    expect(skill?.content).toBe("# incident-tools\n\nDo the thing.");
    expect(skill?.files.map((f) => f.path)).toEqual([
      "fixtures/incidents/a.json",
      "playbooks/db.md",
      "run",
      "tools.cjs",
    ]);
    // Exec bit from the zip, and a shebang without one: both runnable.
    expect(skill?.files.filter((f) => f.executable).map((f) => f.path)).toEqual(
      ["run", "tools.cjs"],
    );
    expect(summarizeSkillFiles(skill?.files ?? [])).toEqual({
      fixtures: 1,
      playbooks: 1,
      tools: 2,
    });
  });

  it("reads SKILL.md at the zip root too", async () => {
    const skill = await onlySkill(
      makeZip([
        { path: "SKILL.md", data: skillMd("root-skill") },
        { path: "references/a.md", data: "a" },
      ]),
    );
    expect(skill.name).toBe("root-skill");
    expect(skill.files.map((f) => f.path)).toEqual(["references/a.md"]);
  });

  it("imports several skills from one zip, each with only its own files", async () => {
    const zip = makeZip([
      { path: "pack/skills/alpha/SKILL.md", data: skillMd("alpha") },
      { path: "pack/skills/alpha/ref.md", data: "a" },
      { path: "pack/skills/beta/SKILL.md", data: skillMd("beta") },
      { path: "pack/skills/beta/ref.md", data: "b" },
    ]);
    const { skills } = await importSkillZip(zip);
    expect(skills.map((s) => [s.name, s.files.map((f) => f.path)])).toEqual([
      ["alpha", ["ref.md"]],
      ["beta", ["ref.md"]],
    ]);
  });

  it("a SKILL.md inside a skill's folder belongs to that skill", async () => {
    const skill = await onlySkill(
      makeZip([
        { path: "outer/SKILL.md", data: skillMd("outer") },
        { path: "outer/examples/inner/SKILL.md", data: skillMd("inner") },
      ]),
    );
    expect(skill.name).toBe("outer");
    expect(skill.files.map((f) => f.path)).toEqual(["examples/inner/SKILL.md"]);
  });

  it("looks no deeper than a plugin's skills folder for SKILL.md", async () => {
    await expect(
      importSkillZip(
        makeZip([{ path: "a/b/c/d/deep/SKILL.md", data: skillMd("deep") }]),
      ),
    ).rejects.toThrow("No SKILL.md found in this zip");
  });

  it("finds no skill inside a folder the import leaves out, but one may be named like it", async () => {
    const { skills } = await importSkillZip(
      makeZip([
        { path: "node_modules/pkg/SKILL.md", data: skillMd("pkg") },
        { path: "lib/venv/tool/SKILL.md", data: skillMd("tool") },
        { path: "venv/SKILL.md", data: skillMd("venv") },
      ]),
    );
    expect(skills.map((s) => s.name)).toEqual(["venv"]);
  });

  it("keeps binary files as bytes", async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0,
    ]);
    const skill = await onlySkill(
      makeZip([
        { path: "s/SKILL.md", data: skillMd("s") },
        { path: "s/assets/logo.png", data: png },
      ]),
    );
    const [file] = skill.files;
    expect(file?.content).toBe("");
    expect(file?.data?.equals(png)).toBe(true);
  });

  it("reports what it leaves out, never drops silently", async () => {
    const skill = await onlySkill(
      makeZip([
        { path: "s/SKILL.md", data: skillMd("s") },
        { path: "s/.DS_Store", data: "x" },
        { path: "__MACOSX/s/._SKILL.md", data: "x" },
        { path: "s/link", data: "/etc/passwd", mode: 0o120777 },
        { path: "s/.hidden", data: "x" },
      ]),
    );
    expect(skill.files).toEqual([]);
    expect(skill.skipped).toEqual(
      expect.arrayContaining([
        { path: ".DS_Store", reason: "System file" },
        { path: "link", reason: "Shortcut (symbolic link)" },
        { path: ".hidden", reason: "Name or folder depth not allowed" },
      ]),
    );
  });

  it("never writes outside the skill: '..' and absolute paths are refused", async () => {
    const skill = await onlySkill(
      makeZip([
        { path: "s/SKILL.md", data: skillMd("s") },
        { path: "s/../../evil.sh", data: "x" },
        { path: "s/a/../../b", data: "x" },
      ]),
    );
    expect(skill.files).toEqual([]);
    expect(skill.skipped).toHaveLength(2);
  });

  it("skips a path that clashes with another in any case, or with a folder", async () => {
    const skill = await onlySkill(
      makeZip([
        { path: "s/SKILL.md", data: skillMd("s") },
        { path: "s/Notes.md", data: "a" },
        { path: "s/notes.md", data: "b" },
        { path: "s/ref", data: "c" },
        { path: "s/ref/a.md", data: "d" },
        { path: "s/skill.MD", data: "e" },
      ]),
    );
    expect(skill.files.map((f) => f.path)).toEqual(["Notes.md", "ref"]);
    expect(skill.skipped.map((s) => s.path).sort()).toEqual([
      "notes.md",
      "ref/a.md",
      "skill.MD",
    ]);
  });

  it("stops a zip bomb at the size cap and refuses the skill whole", async () => {
    const huge = Buffer.alloc(11 * 1024 * 1024, 0x61);
    const { skills, problems } = await importSkillZip(
      makeZip([
        { path: "s/SKILL.md", data: skillMd("s") },
        // Declares 10 bytes, inflates to 11 MB.
        { path: "s/bomb.txt", data: huge, declaredSize: 10 },
      ]),
    );
    expect(skills).toEqual([]);
    expect(problems).toEqual([
      { folder: "s", reason: "The skill would be larger than 10 MB" },
    ]);
  });

  it("refuses a skill whole when a file declares more than the room left", async () => {
    const { skills, problems } = await importSkillZip(
      makeZip([
        { path: "s/SKILL.md", data: skillMd("s") },
        { path: "s/a.md", data: "a" },
        { path: "s/big.bin", data: "x", declaredSize: 11 * 1024 * 1024 },
      ]),
    );
    expect(skills).toEqual([]);
    expect(problems).toEqual([
      { folder: "s", reason: "The skill would be larger than 10 MB" },
    ]);
  });

  it("leaves out generated files and dotenv files, saying why", async () => {
    const skill = await onlySkill(
      makeZip([
        { path: "s/SKILL.md", data: skillMd("s") },
        { path: "s/scripts/run.py", data: "print(1)" },
        { path: "s/scripts/__pycache__/run.cpython-312.pyc", data: "" },
        { path: "s/scripts/old.pyc", data: "" },
        { path: "s/.venv/lib/x.py", data: "x" },
        { path: "s/venv/lib/y.py", data: "y" },
        { path: "s/.vscode/settings.json", data: "{}" },
        { path: "s/.env", data: "KEY=1" },
        { path: "s/config/.env.local", data: "KEY=1" },
      ]),
    );
    expect(skill.files.map((f) => f.path)).toEqual(["scripts/run.py"]);
    expect(skill.skipped).toEqual(
      expect.arrayContaining([
        {
          path: "scripts/__pycache__/run.cpython-312.pyc",
          reason: "Generated file",
        },
        { path: "scripts/old.pyc", reason: "Generated file" },
        { path: ".venv/lib/x.py", reason: "Generated file" },
        { path: "venv/lib/y.py", reason: "Generated file" },
        { path: ".vscode/settings.json", reason: "Generated file" },
        { path: ".env", reason: "Possible secrets file" },
        { path: "config/.env.local", reason: "Possible secrets file" },
      ]),
    );
  });

  it("refuses a skill whole when its real files pass the file cap", async () => {
    const files = Array.from({ length: 205 }, (_, i) => ({
      path: `s/lib/f${String(i).padStart(3, "0")}.py`,
      data: "x",
    }));
    const { skills, problems } = await importSkillZip(
      makeZip([
        { path: "s/SKILL.md", data: skillMd("s") },
        ...files,
        // Generated files never count toward the cap.
        ...files.map((f) => ({
          path: f.path.replace("lib/", "lib/__pycache__/") + "c",
          data: "",
        })),
      ]),
    );
    expect(skills).toEqual([]);
    expect(problems).toEqual([
      {
        folder: "s",
        reason:
          "A skill holds at most 200 files, SKILL.md included, and this one has 206, not counting the files left out. Remove some, then import again",
      },
    ]);
  });

  it("imports a library whose cache alone would have passed the cap", async () => {
    const files = Array.from({ length: 150 }, (_, i) => ({
      path: `s/vendor/m${i}.py`,
      data: "x",
    }));
    const skill = await onlySkill(
      makeZip([
        { path: "s/SKILL.md", data: skillMd("s") },
        ...files,
        ...files.map((f) => ({
          path: f.path.replace("vendor/", "vendor/__pycache__/") + "c",
          data: "",
        })),
      ]),
    );
    expect(skill.files).toHaveLength(150);
  });

  it("fingerprints the skill the way shasum does on the folder", async () => {
    const md = skillMd("s");
    const skill = await onlySkill(
      makeZip([
        { path: "s/SKILL.md", data: md },
        { path: "s/b.txt", data: "two" },
        { path: "s/a/z.txt", data: "one" },
        { path: "s/__pycache__/x.pyc", data: "ignored" },
      ]),
    );
    const sha = (d: string) => createHash("sha256").update(d).digest("hex");
    // `find . -type f | cut -c3- | LC_ALL=C sort | xargs shasum -a 256`
    const listing =
      `${sha(md)}  SKILL.md\n` +
      `${sha("one")}  a/z.txt\n` +
      `${sha("two")}  b.txt\n`;
    expect(skill.fingerprint).toBe(sha(listing));
  });

  it("the check command recomputes the fingerprint on the source folder", async () => {
    // A real folder holding a file for every leave-out rule (generated from
    // the table, so a new rule is covered without touching this test) plus
    // each path rule's edge: the check must reach the import's verdict on
    // every one, or this fails.
    const root = mkdtempSync(join(tmpdir(), "skill-check-"));
    const folder = join(root, "demo");
    const asName = (glob: string) => glob.replaceAll("*", "x");
    const files: Record<string, string | Buffer> = {
      "SKILL.md": skillMd("demo"),
      "scripts/run.py": "print(1)\n",
      "lib/venv.py": "kept: only a folder named venv is generated",
      "refs/_under.md": "kept",
      "a/b/c/d/e/six.md": "kept: six deep",
      "assets/logo.bin": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]),
      "empty.txt": "",
      "a/b/c/d/e/f/seven.md": "too deep",
      // 217 characters, past SKILL_FILE_PATH_MAX_LENGTH.
      [`${"l".repeat(70)}/${"o".repeat(70)}/${"n".repeat(70)}/g.md`]: "long",
      ".hidden/notes.md": "hidden folder",
      "refs/my notes.md": "space",
      "refs/café.md": "accent",
      "refs/-dash.md": "dash",
      ...Object.fromEntries(
        SKILL_LEAVE_OUT_RULES.flatMap((rule) => [
          ...rule.folders.map((f) => [`in-folder/${f}/inside.md`, "x"]),
          ...rule.files.flatMap((f) => [
            [`as-file/${asName(f)}`, "x"],
            [`as-upper/${asName(f).toUpperCase()}`, "x"],
          ]),
        ]),
      ),
    };
    try {
      for (const [path, data] of Object.entries(files)) {
        mkdirSync(dirname(join(folder, path)), { recursive: true });
        writeFileSync(join(folder, path), data);
      }
      // What `zip -r demo.zip demo` stores: every file under the folder.
      const entries = readdirSync(folder, { recursive: true, encoding: "utf8" })
        .filter((path) => statSync(join(folder, path)).isFile())
        .map((path) => ({
          path: `demo/${path}`,
          data: readFileSync(join(folder, path)),
        }));
      const skill = await onlySkill(makeZip(entries));
      expect(skill.files.map((f) => f.path).sort()).toEqual([
        "a/b/c/d/e/six.md",
        "assets/logo.bin",
        "empty.txt",
        "lib/venv.py",
        "refs/_under.md",
        "scripts/run.py",
      ]);
      const check = () =>
        execFileSync("sh", ["-c", skillCheckCommand(skill.fingerprint)], {
          cwd: folder,
          encoding: "utf8",
        }).trim();
      expect(check()).toBe("Matches the imported skill");
      writeFileSync(join(folder, "scripts/run.py"), "print(2)\n");
      expect(check()).toBe("Doesn't match the imported skill");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves out a file whose bytes don't match its checksum", async () => {
    const skill = await onlySkill(
      makeZip([
        { path: "s/SKILL.md", data: skillMd("s") },
        { path: "s/ok.md", data: "fine" },
        { path: "s/bad.md", data: "flipped", badCrc: true },
      ]),
    );
    expect(skill.files.map((f) => f.path)).toEqual(["ok.md"]);
    expect(skill.skipped).toEqual([
      { path: "bad.md", reason: "The zip is damaged" },
    ]);
  });

  it("refuses entries that share one record (the overlapping-file bomb)", async () => {
    const zip = makeZip([
      { path: "s/SKILL.md", data: skillMd("s") },
      { path: "s/a.txt", data: "a".repeat(1000) },
    ]);
    // Point the second central entry's local offset at the first record.
    const cd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(0, cd + 42);
    await expect(importSkillZip(zip)).rejects.toThrow("The zip is damaged");
  });

  it("lands text byte-exact, a byte-order mark included", async () => {
    const xml = Buffer.from("\uFEFF<?xml version='1.0'?>\r\n<a/>\r\n", "utf8");
    const skill = await onlySkill(
      makeZip([
        { path: "s/SKILL.md", data: `\uFEFF${skillMd("s")}` },
        { path: "s/schema.xsd", data: xml },
      ]),
    );
    expect(skill.name).toBe("s");
    expect(Buffer.from(skill.files[0]?.content ?? "", "utf8")).toEqual(xml);
  });

  it("says why a password-protected SKILL.md can't be read", async () => {
    const zip = makeZip([{ path: "s/SKILL.md", data: skillMd("s") }]);
    zip.writeUInt16LE(
      0x0801,
      zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8,
    );
    const { problems } = await importSkillZip(zip);
    expect(problems).toEqual([
      {
        folder: "s",
        reason: "SKILL.md: Password-protected files can't be read",
      },
    ]);
  });

  it("leaves out a ZIP64 entry with a reason", async () => {
    const skill = await onlySkill(
      makeZip([
        { path: "s/SKILL.md", data: skillMd("s") },
        { path: "s/big.bin", data: "x", stored: true, zip64: true },
      ]),
    );
    expect(skill.files).toEqual([]);
    expect(skill.skipped).toHaveLength(1);
  });

  it("finds the directory past a zip comment", async () => {
    const skill = await onlySkill(
      makeZip([{ path: "s/SKILL.md", data: skillMd("s") }], "made by a tool"),
    );
    expect(skill.name).toBe("s");
  });

  it("imports neither of two folders that claim one name", async () => {
    const { skills, problems } = await importSkillZip(
      makeZip([
        { path: "a/dup/SKILL.md", data: skillMd("dup") },
        { path: "b/dup/SKILL.md", data: skillMd("dup") },
        { path: "ok/SKILL.md", data: skillMd("ok") },
      ]),
    );
    expect(skills.map((s) => s.name)).toEqual(["ok"]);
    expect(problems.map((p) => p.folder).sort()).toEqual(["a/dup", "b/dup"]);
  });

  it("imports a long SKILL.md the standard allows, up to its own limit", async () => {
    const md = (name: string, size: number) =>
      `---\nname: ${name}\ndescription: Long one.\n---\n\n${"x".repeat(size)}\n`;
    const skill = await onlySkill(
      makeZip([{ path: "long/SKILL.md", data: md("long", 40_000) }]),
    );
    expect(skill.content).toHaveLength(40_000);
    const { problems } = await importSkillZip(
      makeZip([{ path: "huge/SKILL.md", data: md("huge", 120_001) }]),
    );
    expect(problems).toEqual([
      { folder: "huge", reason: "SKILL.md is longer than 120,000 characters" },
    ]);
  });

  it("accepts a description up to the standard's 1,024 characters", async () => {
    const long = "x".repeat(1024);
    const skill = await onlySkill(
      makeZip([{ path: "s/SKILL.md", data: skillMd("s", long) }]),
    );
    expect(skill.description).toBe(long);
    const { problems } = await importSkillZip(
      makeZip([{ path: "t/SKILL.md", data: skillMd("t", `${long}x`) }]),
    );
    expect(problems).toEqual([
      {
        folder: "t",
        reason: "The description is longer than 1,024 characters",
      },
    ]);
  });

  it("stores the description as one clean line", async () => {
    const bel = String.fromCharCode(0x07);
    const rlo = String.fromCharCode(0x202e);
    const skill = await onlySkill(
      makeZip([
        {
          path: "s/SKILL.md",
          data: skillMd("s", `Use${bel} it${rlo} for\treleases`),
        },
      ]),
    );
    expect(skill.description).toBe("Use it for releases");
    const { problems } = await importSkillZip(
      makeZip([{ path: "t/SKILL.md", data: skillMd("t", `"${bel}${rlo}"`) }]),
    );
    expect(problems).toEqual([
      { folder: "t", reason: "SKILL.md has no description" },
    ]);
  });

  it("explains a folder that can't be a skill, clipping what it echoes", async () => {
    const zip = makeZip([
      { path: "good/SKILL.md", data: skillMd("good") },
      { path: "Bad Name/SKILL.md", data: skillMd("Bad Name") },
      { path: "mismatch/SKILL.md", data: skillMd("other") },
      { path: "nodesc/SKILL.md", data: "---\nname: nodesc\n---\nbody" },
      { path: `${"n".repeat(300)}/SKILL.md`, data: skillMd("x") },
    ]);
    const { skills, problems } = await importSkillZip(zip);
    expect(skills.map((s) => s.name)).toEqual(["good"]);
    expect(problems).toHaveLength(4);
    for (const problem of problems) {
      expect(problem.folder.length).toBeLessThanOrEqual(121);
    }
  });

  it("refuses something that isn't a skill zip, in plain words", async () => {
    await expect(
      importSkillZip(Buffer.from("not a zip at all")),
    ).rejects.toThrow(ZipError);
    await expect(
      importSkillZip(makeZip([{ path: "a.txt", data: "a" }])),
    ).rejects.toThrow("No SKILL.md found in this zip");
  });
});

describe("summarizeSkillFiles", () => {
  it("names the most common kinds and counts the rest as other", () => {
    const files = Array.from({ length: 9 }, (_, i) => ({
      path: `k${i}/f.md`,
      executable: false,
    }));
    const summary = summarizeSkillFiles([
      ...files,
      { path: "k0/g.md", executable: false },
    ]);
    expect(Object.keys(summary)).toHaveLength(7);
    expect(summary.k0).toBe(2);
    expect(summary.other).toBe(3);
  });
});
