"use client";

import { toast } from "sonner";
import {
  useAgentLibrarySkills,
  useDetachLibrarySkill,
  useOrgSkillLibrary,
  useSetLibrarySkillEnabled,
} from "@/hooks/use-skill-library";
import { LibrarySkillRow } from "./library-skill-row";
import { LoadFailed } from "./load-failed";

export interface AgentLibrarySectionProps {
  agentId: string;
}

/**
 * "From library" on an agent's Skills page: the library skills this agent
 * added, each with its on/off switch (like a regular skill) and remove.
 * Read-only content: the repo is the source of truth. A failed read says so
 * (with Retry) rather than looking like "no library skills".
 */
export const AgentLibrarySection = ({ agentId }: AgentLibrarySectionProps) => {
  const skills = useAgentLibrarySkills(agentId);
  const org = useOrgSkillLibrary();
  const detach = useDetachLibrarySkill(agentId);
  const setEnabled = useSetLibrarySkillEnabled(agentId);
  if (skills.isError) {
    return (
      <LoadFailed
        message="Couldn't load this agent's library skills."
        onRetry={() => void skills.refetch()}
      />
    );
  }
  const rows = skills.data?.skills ?? [];
  if (rows.length === 0) return null;
  const repo = org.data?.source?.repo ?? null;
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-semibold">From library</h3>
        <p className="text-muted-foreground text-xs">
          {repo ? `Synced from ${repo}. ` : ""}Read-only: fixes go through a
          pull request to the repo.
        </p>
      </div>
      <div className="divide-y rounded-md border">
        {rows.map((skill) => (
          <LibrarySkillRow
            key={skill.id}
            skill={skill}
            repo={repo}
            removing={detach.isPending && detach.variables === skill.name}
            onRemove={() =>
              detach.mutate(skill.name, {
                onSuccess: () =>
                  toast.success(`Removed ${skill.name} from this agent`),
                onError: (e: Error) => toast.error(e.message),
              })
            }
            onToggle={(enabled) =>
              setEnabled.mutate({ name: skill.name, enabled })
            }
          />
        ))}
      </div>
    </section>
  );
};
