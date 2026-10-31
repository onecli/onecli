"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { agentSectionPath } from "@/lib/navigation";
import { formatBytes } from "@/lib/format-bytes";
import type { SkillImportCardData } from "@/lib/chat/skill-import";

export interface SkillImportCardProps {
  data: SkillImportCardData;
}

/** Plain words for the summary's own kinds; a folder kind reads as its
 * name ("playbooks"). A Map, so a folder named "constructor" reads as
 * itself rather than an inherited property. */
const KIND_LABEL = new Map([
  ["tools", "runnable tools"],
  ["files", "loose files"],
  ["other", "other files"],
]);

/**
 * What a skill import did, in the chat under the agent's reply: one row
 * per skill (name, size, what's inside), anything left out and why, and a
 * link to the Skills page. Built only from the tool's own result.
 */
export const SkillImportCard = ({ data }: SkillImportCardProps) => {
  const params = useParams<{ agentId?: string }>();
  const pathname = usePathname();
  const agentId = params?.agentId;

  return (
    <div
      data-testid="skill-import-card"
      className="bg-card flex w-full max-w-xl flex-col gap-3 rounded-xl border p-4 text-sm"
    >
      {data.skills.map((skill) => {
        const parts = Object.entries(skill.groups)
          .sort((a, b) => b[1] - a[1])
          .map(([kind, count]) => `${count} ${KIND_LABEL.get(kind) ?? kind}`);
        return (
          <div key={skill.name} className="flex gap-2.5">
            <CheckCircle2
              className="text-brand mt-0.5 size-4 shrink-0"
              aria-hidden
            />
            <div className="min-w-0 space-y-0.5">
              <p className="font-medium">
                {skill.name}{" "}
                <span className="text-muted-foreground font-normal">
                  {skill.replaced ? "updated" : "added"} · {skill.files} files ·{" "}
                  {formatBytes(skill.bytes)}
                </span>
              </p>
              {parts.length > 0 && (
                <p className="text-muted-foreground">
                  Instructions, {parts.join(", ")}
                </p>
              )}
              {skill.skippedCount > 0 && (
                <p className="text-muted-foreground">
                  Left out {skill.skippedCount}:{" "}
                  {skill.skipped
                    .slice(0, 3)
                    .map((s) => `${s.path} (${s.reason.toLowerCase()})`)
                    .join(", ")}
                  {skill.skippedCount > 3 && "…"}
                </p>
              )}
            </div>
          </div>
        );
      })}

      {data.problems.map((problem, index) => (
        // Folders can repeat (two claiming one name): the position is the
        // stable identity within one result.
        <div key={index} className="flex gap-2.5">
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0 text-amber-500"
            aria-hidden
          />
          <p>
            <span className="font-medium">{problem.folder || "The zip"}</span>{" "}
            <span className="text-muted-foreground">
              wasn&apos;t added: {problem.reason}
            </span>
          </p>
        </div>
      ))}

      {data.problemCount > data.problems.length && (
        <p className="text-muted-foreground">
          And {data.problemCount - data.problems.length} more not added.
        </p>
      )}

      {agentId && data.skills.length > 0 && (
        <Link
          href={agentSectionPath(pathname, agentId, "skills")}
          className="text-brand self-start text-sm underline underline-offset-2 hover:opacity-80"
        >
          Open skills
        </Link>
      )}
    </div>
  );
};
