"use client";

import { AlertTriangle, ExternalLink } from "lucide-react";
import type { RepoSkill } from "@/lib/api";

export interface RepoSkillProblemProps {
  skill: RepoSkill;
  /** Links to a folder of the listed commit on GitHub. */
  folderUrl: (path: string) => string;
}

/** The short chip for a problem: what kind of thing to fix in the repo. */
const problemLabel = (skill: RepoSkill) =>
  skill.conflicts.length > 0
    ? "Name used twice"
    : /too large|larger than/i.test(skill.problem ?? "")
      ? "Too large"
      : "Can't be used";

/**
 * Why a repo skill can't be added, in the row: an amber chip naming the kind
 * of problem, then the reason. A duplicate name lists the other folders that
 * claim it, linked, so the repo owner sees exactly what to rename.
 */
export const RepoSkillProblem = ({
  skill,
  folderUrl,
}: RepoSkillProblemProps) => (
  <div className="mt-1 space-y-1">
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-medium text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300">
        <AlertTriangle className="size-3" aria-hidden />
        {problemLabel(skill)}
      </span>
      {skill.conflicts.length === 0 && (
        <span className="text-muted-foreground">{skill.problem}</span>
      )}
    </div>
    {skill.conflicts.length > 0 && (
      <ul className="text-muted-foreground space-y-0.5 text-xs">
        <li>Rename one so each skill has its own name. Also in:</li>
        {skill.conflicts.map((path) => (
          <li key={path}>
            <a
              href={folderUrl(path)}
              target="_blank"
              rel="noreferrer"
              className="text-foreground inline-flex items-center gap-1 font-mono underline-offset-2 hover:underline"
            >
              {path}
              <ExternalLink className="size-3" aria-hidden />
              <span className="sr-only">(opens GitHub)</span>
            </a>
          </li>
        ))}
      </ul>
    )}
  </div>
);
