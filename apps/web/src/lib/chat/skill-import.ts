/**
 * What a `skill_import` call did, read from the tool's own result in the
 * transcript: the chat turns it into a small card under the agent's reply.
 * The output is untrusted sandbox-relayed text, so it is parsed defensively:
 * anything that doesn't match the expected shape yields null (no card).
 */

export interface SkillImportCardSkill {
  name: string;
  files: number;
  bytes: number;
  groups: Record<string, number>;
  skipped: { path: string; reason: string }[];
  skippedCount: number;
  replaced: boolean;
}

export interface SkillImportCardData {
  skills: SkillImportCardSkill[];
  problems: { folder: string; reason: string }[];
  /** Every problem, including those past the listed ones. */
  problemCount: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;

const reasons = (v: unknown, key: "path" | "folder") =>
  Array.isArray(v)
    ? v.flatMap((item) => {
        if (!isRecord(item)) return [];
        const where = str(item[key]);
        const reason = str(item.reason);
        return where !== null && reason ? [{ where, reason }] : [];
      })
    : [];

/** True for the skill_import tool, MCP-prefixed or bare. */
export const isSkillImportTool = (name: string): boolean =>
  name === "skill_import" || name.endsWith("__skill_import");

export const parseSkillImport = (
  output: string | undefined,
): SkillImportCardData | null => {
  if (!output) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.imported)) return null;
  const skills = parsed.imported.flatMap((raw): SkillImportCardSkill[] => {
    if (!isRecord(raw)) return [];
    const name = str(raw.name);
    if (!name) return [];
    // fromEntries defines own keys, so a folder named "__proto__" is a
    // count like any other, never a prototype write.
    const groups: Record<string, number> = isRecord(raw.groups)
      ? Object.fromEntries(
          Object.entries(raw.groups).flatMap(([kind, count]) =>
            num(count) > 0 ? [[kind, num(count)]] : [],
          ),
        )
      : {};
    const skipped = reasons(raw.skipped, "path").map(({ where, reason }) => ({
      path: where,
      reason,
    }));
    return [
      {
        name,
        files: num(raw.files),
        bytes: num(raw.bytes),
        groups,
        skipped,
        skippedCount: Math.max(num(raw.skippedCount), skipped.length),
        replaced: raw.replaced === true,
      },
    ];
  });
  const problems = reasons(parsed.problems, "folder").map(
    ({ where, reason }) => ({ folder: where, reason }),
  );
  if (skills.length === 0 && problems.length === 0) return null;
  return {
    skills,
    problems,
    problemCount: Math.max(num(parsed.problemCount), problems.length),
  };
};
