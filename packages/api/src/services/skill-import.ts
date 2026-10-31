import {
  IMPORTED_SKILL_CONTENT_MAX_LENGTH,
  MAX_IMPORTED_SKILL_BYTES,
  MAX_IMPORTED_SKILL_FILES,
  MAX_SKILL_ZIP_ENTRIES,
  MAX_SKILL_ZIP_UNPACKED_BYTES,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_FILE_PATH_MAX_LENGTH,
  SKILL_FILE_PATH_PATTERN,
  SKILL_NAME_MAX_LENGTH,
  SKILL_NAME_PATTERN,
  RESERVED_SKILL_NAMES,
  skillPathClashes,
} from "../validations/skills";
import {
  decodeUtf8Text,
  parseSkillFrontmatter,
  stripSkillFrontmatter,
} from "../apps/github-skill-repo";
import { readZip, ZipError, type ZipEntry } from "../lib/zip";

/**
 * Turn a skill zip (the format Claude, Codex and the agentskills.io standard
 * share) into skills ready to save. Pure: no database, no network. A zip may
 * hold one skill (SKILL.md at the root or inside one top folder) or several
 * (one folder each). Nothing is dropped silently: every file left out is
 * reported with a plain reason the person can act on.
 */

export interface ImportedFile {
  path: string;
  /** Text files: the content. Binary files: "" with `data` set. */
  content: string;
  data: Buffer | null;
  executable: boolean;
}

export interface ImportedSkill {
  /** The folder it came from inside the zip ("" = the zip root), clipped
   * for echoing back. */
  folder: string;
  name: string;
  description: string;
  /** The SKILL.md body, frontmatter removed. */
  content: string;
  files: ImportedFile[];
  /** SKILL.md's body plus every file, in bytes. */
  bytes: number;
  skipped: { path: string; reason: string }[];
}

export interface SkillZipResult {
  skills: ImportedSkill[];
  /** Folders that looked like skills but can't be imported, with why. */
  problems: { folder: string; reason: string }[];
}

const SKILL_FILE = "skill.md";
/** How deep a SKILL.md may sit: a plugin zip is plugin/skills/<name>/. */
const MAX_SKILL_FOLDER_DEPTH = 3;
/** A folder or name echoed back in a problem is clipped: it is zip text. */
const MAX_ECHO_CHARS = 120;
const TOO_LARGE = `The skill would be larger than ${MAX_IMPORTED_SKILL_BYTES / (1024 * 1024)} MB`;
const BODY_TOO_LONG = `SKILL.md is longer than ${IMPORTED_SKILL_CONTENT_MAX_LENGTH.toLocaleString("en-US")} characters`;

const clip = (text: string): string => {
  // Zip text is echoed to people and models: control characters become "?"
  // so nothing grows past its clipped length when serialized.
  const plain = text.replace(/\p{Cc}/gu, "?");
  return plain.length > MAX_ECHO_CHARS
    ? `${plain.slice(0, MAX_ECHO_CHARS)}…`
    : plain;
};

const baseName = (path: string): string => path.split("/").at(-1) ?? "";

/** OS and tool clutter: left out quietly-but-reported, never imported. */
const isClutter = (path: string): boolean => {
  const segments = path.split("/");
  const last = segments.at(-1) ?? "";
  return (
    segments.some(
      (s) => s === "__MACOSX" || s === ".git" || s === "node_modules",
    ) ||
    last === ".DS_Store" ||
    last === "Thumbs.db" ||
    last === "desktop.ini" ||
    last.startsWith("._")
  );
};

const folderOf = (skillMdPath: string): string => {
  const at = skillMdPath.lastIndexOf("/");
  return at < 0 ? "" : skillMdPath.slice(0, at);
};

const isInside = (path: string, folder: string): boolean =>
  folder === "" || path.startsWith(`${folder}/`);

/**
 * The skill folders of a zip: each folder holding a SKILL.md, at most
 * MAX_SKILL_FOLDER_DEPTH deep. A SKILL.md inside another skill's folder is
 * part of that outer skill, not a skill of its own (the library rule).
 */
const skillFolders = (entries: ZipEntry[]): string[] => {
  const candidates = [
    ...new Set(
      entries
        .filter(
          (e) =>
            !isClutter(e.path) && baseName(e.path).toLowerCase() === SKILL_FILE,
        )
        .map((e) => folderOf(e.path))
        .filter(
          (folder) =>
            folder.split("/").filter(Boolean).length <= MAX_SKILL_FOLDER_DEPTH,
        ),
    ),
  ].sort((a, b) => a.length - b.length);
  const outer: string[] = [];
  for (const folder of candidates) {
    if (!outer.some((o) => o !== folder && isInside(folder, o))) {
      outer.push(folder);
    }
  }
  return outer;
};

const nameProblem = (name: string | null, folder: string): string | null => {
  if (!name) return "SKILL.md has no name";
  if (name.length > SKILL_NAME_MAX_LENGTH || !SKILL_NAME_PATTERN.test(name)) {
    return `"${clip(name)}" isn't a valid skill name (lowercase words joined by hyphens)`;
  }
  if ((RESERVED_SKILL_NAMES as readonly string[]).includes(name)) {
    return `"${name}" is reserved`;
  }
  const leaf = baseName(folder);
  if (leaf !== "" && leaf !== name) {
    return `The name "${name}" doesn't match its folder "${clip(leaf)}"`;
  }
  return null;
};

/** Unpacked bytes across the whole zip, against MAX_SKILL_ZIP_UNPACKED_BYTES. */
interface UnpackBudget {
  used: number;
}

/** Read one skill folder, or the reason it can't be a skill. */
const readSkill = async (
  folder: string,
  own: ZipEntry[],
  budget: UnpackBudget,
): Promise<ImportedSkill | { problem: string }> => {
  const prefix = folder === "" ? "" : `${folder}/`;
  const skillMd = own.find(
    (e) => e.path.slice(prefix.length).toLowerCase() === SKILL_FILE,
  );
  if (!skillMd) return { problem: "SKILL.md is missing" };
  let skillMdText: string | null;
  try {
    const bytes = await skillMd.read(
      Math.min(
        // Frontmatter rides on top of the body: room for both, in UTF-8.
        IMPORTED_SKILL_CONTENT_MAX_LENGTH * 4,
        MAX_SKILL_ZIP_UNPACKED_BYTES - budget.used,
      ),
    );
    budget.used += bytes.length;
    skillMdText = decodeUtf8Text(bytes);
  } catch (err) {
    if (!(err instanceof ZipError)) throw err;
    return {
      problem:
        err.code === "too_large" ? BODY_TOO_LONG : `SKILL.md: ${err.message}`,
    };
  }
  if (skillMdText === null) return { problem: "SKILL.md isn't a text file" };
  const front = parseSkillFrontmatter(skillMdText);
  const problem = nameProblem(front.name, folder);
  if (problem || !front.name) return { problem: problem ?? "No name" };
  if (!front.description) return { problem: "SKILL.md has no description" };
  // parseSkillFrontmatter hands back the description already cleaned.
  const description = front.description;
  if (description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
    return {
      problem: `The description is longer than ${SKILL_DESCRIPTION_MAX_LENGTH.toLocaleString("en-US")} characters`,
    };
  }
  const content = stripSkillFrontmatter(skillMdText).trim();
  if (content.length === 0) return { problem: "SKILL.md has no instructions" };
  if (content.length > IMPORTED_SKILL_CONTENT_MAX_LENGTH) {
    return { problem: BODY_TOO_LONG };
  }

  const skill: ImportedSkill = {
    folder: clip(folder),
    name: front.name,
    description,
    content,
    files: [],
    bytes: Buffer.byteLength(content),
    skipped: [],
  };
  const skip = (path: string, reason: string) =>
    skill.skipped.push({ path: clip(path), reason });
  // SKILL.md is the rendered file's own path.
  const taken = new Set<string>([SKILL_FILE]);

  for (const entry of [...own].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (entry === skillMd || entry.isDirectory) continue;
    const rel = entry.path.slice(prefix.length);
    if (isClutter(entry.path)) {
      skip(rel, "System file");
      continue;
    }
    if (entry.isSymlink) {
      skip(rel, "Shortcut (symbolic link)");
      continue;
    }
    if (
      rel.length > SKILL_FILE_PATH_MAX_LENGTH ||
      !SKILL_FILE_PATH_PATTERN.test(rel)
    ) {
      skip(rel, "Name or folder depth not allowed");
      continue;
    }
    if (skillPathClashes(rel, taken)) {
      skip(rel, "Clashes with another file of the same name");
      continue;
    }
    // SKILL.md is one of the skill's files (MAX_IMPORTED_SKILL_FILES).
    if (skill.files.length >= MAX_IMPORTED_SKILL_FILES - 1) {
      skip(rel, `More than ${MAX_IMPORTED_SKILL_FILES} files`);
      continue;
    }
    const room = Math.min(
      MAX_IMPORTED_SKILL_BYTES - skill.bytes,
      MAX_SKILL_ZIP_UNPACKED_BYTES - budget.used,
    );
    if (entry.declaredSize > room) {
      skip(rel, TOO_LARGE);
      continue;
    }
    let bytes: Buffer;
    try {
      // Never trust the declared size: inflate with the real room as cap.
      bytes = await entry.read(room);
    } catch (err) {
      if (!(err instanceof ZipError)) throw err;
      skip(rel, err.code === "too_large" ? TOO_LARGE : err.message);
      continue;
    }
    budget.used += bytes.length;
    taken.add(rel.toLowerCase());
    const text = decodeUtf8Text(bytes);
    skill.files.push({
      path: rel,
      content: text ?? "",
      data: text === null ? bytes : null,
      executable: entry.executable || (text?.startsWith("#!") ?? false),
    });
    skill.bytes += bytes.length;
  }
  return skill;
};

/** Read a skill zip. Throws ZipError with a plain message when the zip as a
 * whole can't be read (not a zip, damaged, too many entries). */
export const importSkillZip = async (zip: Buffer): Promise<SkillZipResult> => {
  const entries = readZip(zip, MAX_SKILL_ZIP_ENTRIES);
  const folders = skillFolders(entries);
  if (folders.length === 0) {
    throw new ZipError("No SKILL.md found in this zip");
  }

  const result: SkillZipResult = { skills: [], problems: [] };
  const budget: UnpackBudget = { used: 0 };
  for (const folder of folders) {
    const read = await readSkill(
      folder,
      entries.filter((e) => isInside(e.path, folder)),
      budget,
    );
    if ("problem" in read) {
      result.problems.push({ folder: clip(folder), reason: read.problem });
    } else {
      result.skills.push(read);
    }
  }

  // Two folders claiming one name: picking one would be a silent guess, so
  // neither is imported (the library's duplicate rule).
  const claims = new Map<string, number>();
  for (const skill of result.skills) {
    claims.set(skill.name, (claims.get(skill.name) ?? 0) + 1);
  }
  result.skills = result.skills.filter((skill) => {
    if (claims.get(skill.name) === 1) return true;
    result.problems.push({
      folder: skill.folder,
      reason: `Another folder in this zip is also named "${skill.name}"`,
    });
    return false;
  });
  result.skills.sort((a, b) => (a.name < b.name ? -1 : 1));
  return result;
};

/** Kinds named in a summary; the rest are counted as "other". */
const MAX_SUMMARY_KINDS = 6;
const MAX_KIND_CHARS = 40;

/**
 * What the person sees: counts by kind, in plain words ("tools" for runnable
 * files, a top folder's name for what is inside it, "files" for loose
 * ones). Bounded: the most common kinds, the rest folded into "other", so a
 * zip of many folders can't flood the chat.
 */
export const summarizeSkillFiles = (
  files: { path: string; executable: boolean }[],
): Record<string, number> => {
  const counts = new Map<string, number>();
  for (const file of files) {
    const at = file.path.indexOf("/");
    const kind = file.executable
      ? "tools"
      : at < 0
        ? "files"
        : file.path.slice(0, at).toLowerCase().slice(0, MAX_KIND_CHARS);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const summary = Object.fromEntries(ranked.slice(0, MAX_SUMMARY_KINDS));
  const other = ranked
    .slice(MAX_SUMMARY_KINDS)
    .reduce((sum, [, count]) => sum + count, 0);
  if (other > 0) summary.other = (summary.other ?? 0) + other;
  return summary;
};
